const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  isFallbackEligibleError,
  transcribeWithWhisper,
  transcribeVoiceWithFallback,
  setWhisperImpl,
} = require('../src/voice/whisperFallback.service');

describe('Whisper Fallback Service (#972)', () => {
  const dummyAudio = Buffer.from('RIFF....WAVEfmt');

  afterEach(() => {
    setWhisperImpl(null);
  });

  test('isFallbackEligibleError detects 5xx server errors and 429 rate limits', () => {
    assert.equal(isFallbackEligibleError({ response: { status: 500 } }), true);
    assert.equal(isFallbackEligibleError({ response: { status: 502 } }), true);
    assert.equal(isFallbackEligibleError({ response: { status: 503 } }), true);
    assert.equal(isFallbackEligibleError({ response: { status: 504 } }), true);
    assert.equal(isFallbackEligibleError({ response: { status: 429 } }), true);
    assert.equal(isFallbackEligibleError({ code: 'ECONNABORTED' }), true);
    assert.equal(isFallbackEligibleError({ code: 'ETIMEDOUT' }), true);
    assert.equal(isFallbackEligibleError({ code: 'ECONNREFUSED' }), true);
    assert.equal(isFallbackEligibleError({ message: 'Deepgram is not configured' }), true);

    // 400 Bad Request or 401 Unauthorized should not trigger generic network fallback
    assert.equal(isFallbackEligibleError({ response: { status: 400 } }), false);
    assert.equal(isFallbackEligibleError({ response: { status: 404 } }), false);
    assert.equal(isFallbackEligibleError(null), false);
  });

  test('transcribeWithWhisper uses mock implementation when provided', async () => {
    setWhisperImpl(async (audio, _options) => {
      assert.equal(audio, dummyAudio);
      return 'Send 50 XLM to Chidi';
    });

    const transcript = await transcribeWithWhisper(dummyAudio);
    assert.equal(transcript, 'Send 50 XLM to Chidi');
  });

  test('transcribeVoiceWithFallback uses primary transcription when successful', async () => {
    const primaryMock = async () => 'Primary Deepgram transcript';
    const fallbackMock = async () => 'Whisper transcript';

    const result = await transcribeVoiceWithFallback(dummyAudio, {
      primaryTranscribe: primaryMock,
      fallbackTranscribe: fallbackMock,
    });

    assert.equal(result.transcript, 'Primary Deepgram transcript');
    assert.equal(result.provider, 'deepgram');
    assert.equal(result.fallback, false);
  });

  test('transcribeVoiceWithFallback automatically falls back to Whisper on Deepgram 500/503 outage', async () => {
    let fallbackCalled = false;
    let onFallbackCalled = false;

    const primaryOutage = async () => {
      const err = new Error('Internal Server Error at Deepgram');
      err.response = { status: 503, data: 'Service Unavailable' };
      throw err;
    };

    const fallbackMock = async (_audio) => {
      fallbackCalled = true;
      return 'Send 100 USDC to Amina';
    };

    const result = await transcribeVoiceWithFallback(dummyAudio, {
      primaryTranscribe: primaryOutage,
      fallbackTranscribe: fallbackMock,
      onFallback: (err) => {
        onFallbackCalled = true;
        assert.equal(err.response.status, 503);
      },
    });

    assert.equal(fallbackCalled, true);
    assert.equal(onFallbackCalled, true);
    assert.equal(result.transcript, 'Send 100 USDC to Amina');
    assert.equal(result.provider, 'whisper_fallback');
    assert.equal(result.fallback, true);
  });

  test('transcribeVoiceWithFallback automatically falls back to Whisper on Deepgram 429 rate limit', async () => {
    const primaryRateLimit = async () => {
      const err = new Error('Too Many Requests');
      err.response = { status: 429, data: 'Rate limit exceeded' };
      throw err;
    };

    const fallbackMock = async () => 'Send 2000 NGN to Tunde';

    const result = await transcribeVoiceWithFallback(dummyAudio, {
      primaryTranscribe: primaryRateLimit,
      fallbackTranscribe: fallbackMock,
    });

    assert.equal(result.transcript, 'Send 2000 NGN to Tunde');
    assert.equal(result.provider, 'whisper_fallback');
    assert.equal(result.fallback, true);
  });

  test('transcribeVoiceWithFallback automatically falls back to Whisper on network connection timeout', async () => {
    const primaryTimeout = async () => {
      const err = new Error('Connection timed out');
      err.code = 'ETIMEDOUT';
      throw err;
    };

    const fallbackMock = async () => 'Tuma elfu mbili kwa Juma';

    const result = await transcribeVoiceWithFallback(dummyAudio, {
      primaryTranscribe: primaryTimeout,
      fallbackTranscribe: fallbackMock,
    });

    assert.equal(result.transcript, 'Tuma elfu mbili kwa Juma');
    assert.equal(result.provider, 'whisper_fallback');
    assert.equal(result.fallback, true);
  });

  test('transcribeVoiceWithFallback does not fall back on 400 client error', async () => {
    const primaryClientError = async () => {
      const err = new Error('Invalid audio payload format');
      err.response = { status: 400 };
      throw err;
    };

    const fallbackMock = async () => 'Should not be called';

    await assert.rejects(
      async () => {
        await transcribeVoiceWithFallback(dummyAudio, {
          primaryTranscribe: primaryClientError,
          fallbackTranscribe: fallbackMock,
        });
      },
      (err) => {
        assert.equal(err.response.status, 400);
        return true;
      }
    );
  });
});
