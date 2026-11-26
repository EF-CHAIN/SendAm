const axios = require('axios');
const config = require('../config/env');
const { outboundHeaders } = require('../observability/context');
const logger = require('../utils/logger');

let _whisperImpl = null;

function setWhisperImpl(fn) {
  _whisperImpl = fn;
}

function isFallbackEligibleError(error) {
  if (!error) return false;
  // Missing API configuration is eligible for fallback
  if (error.message && error.message.includes('Deepgram is not configured')) {
    return true;
  }
  const status = error.response?.status || error.status;
  if (typeof status === 'number') {
    // 5xx server error or 429 rate limit
    if ((status >= 500 && status < 600) || status === 429) {
      return true;
    }
  }
  const code = error.code || '';
  if (['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'ERR_NETWORK'].includes(code)) {
    return true;
  }
  return false;
}

async function transcribeWithWhisper(audioBuffer, options = {}) {
  if (_whisperImpl) {
    return _whisperImpl(audioBuffer, options);
  }

  const voiceConfig = config.voice || {};
  const apiKey = options.apiKey || voiceConfig.whisperApiKey;
  const rawBaseUrl = options.baseUrl || voiceConfig.whisperBaseUrl || 'https://api.openai.com/v1';
  const baseUrl = rawBaseUrl.replace(/\/+$/, '');
  const model = options.model || voiceConfig.whisperModel || 'whisper-1';
  const timeoutMs = options.timeoutMs || voiceConfig.whisperTimeoutMs || 30000;
  const filename = options.filename || 'audio.ogg';
  const mimeType = options.mimeType || 'audio/ogg';

  // Construct standard FormData using built-in FormData and Blob
  const formData = new FormData();
  const audioBlob = new Blob([audioBuffer], { type: mimeType });
  formData.append('file', audioBlob, filename);
  formData.append('model', model);

  if (options.language) {
    formData.append('language', options.language);
  }
  if (options.prompt) {
    formData.append('prompt', options.prompt);
  }

  const headers = {
    ...outboundHeaders(),
    ...(options.headers || {}),
  };

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const url = `${baseUrl}/audio/transcriptions`;

  const response = await axios.post(url, formData, {
    headers,
    timeout: timeoutMs,
  });

  const transcript = response.data?.text || response.data?.transcript || '';
  return transcript.trim();
}

async function transcribeVoiceWithFallback(audioBuffer, options = {}) {
  const {
    primaryTranscribe,
    fallbackTranscribe = transcribeWithWhisper,
    onFallback,
  } = options;

  let primaryError = null;

  try {
    if (primaryTranscribe) {
      const result = await primaryTranscribe(audioBuffer);
      return {
        transcript: typeof result === 'string' ? result : (result?.transcript || ''),
        provider: 'deepgram',
        fallback: false,
      };
    }

    // Default primary: Deepgram transcription
    if (!config.voice?.deepgramApiKey) {
      throw new Error('Deepgram is not configured. Set DEEPGRAM_API_KEY.');
    }

    const response = await axios.post(
      'https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true',
      audioBuffer,
      {
        headers: {
          Authorization: `Token ${config.voice.deepgramApiKey}`,
          'Content-Type': options.contentType || 'audio/ogg',
          ...outboundHeaders(),
        },
        timeout: 60000,
      }
    );

    const transcript = response.data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
    return {
      transcript: transcript.trim(),
      provider: 'deepgram',
      fallback: false,
    };
  } catch (err) {
    primaryError = err;
  }

  if (primaryError) {
    if (isFallbackEligibleError(primaryError) || options.forceFallback) {
      logger.warn('deepgram_transcription_failed_fallback_to_whisper', {
        errorMessage: primaryError.message,
        statusCode: primaryError.response?.status,
        code: primaryError.code,
      });

      if (typeof onFallback === 'function') {
        try {
          onFallback(primaryError);
        } catch (_) {
          // onFallback is a best-effort observer; its failure must not block the fallback.
        }
      }

      const fallbackResult = await fallbackTranscribe(audioBuffer, options);
      const transcript = typeof fallbackResult === 'string' ? fallbackResult : (fallbackResult?.transcript || '');

      return {
        transcript: transcript.trim(),
        provider: 'whisper_fallback',
        fallback: true,
        primaryError: primaryError.message,
      };
    }

    // If error is not fallback-eligible, rethrow original error
    throw primaryError;
  }
}

module.exports = {
  transcribeWithWhisper,
  transcribeVoiceWithFallback,
  isFallbackEligibleError,
  setWhisperImpl,
};
