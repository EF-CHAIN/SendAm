const crypto = require('crypto');
const config = require('../config/env');
const prisma = require('../common/prisma');

const DEFAULT_CONFIDENCE_THRESHOLD = 0.75;
const MIN_ENROLLMENT_SAMPLES = 3;

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function bufferToFloat32Array(buf) {
  if (!buf) return null;
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function float32ArrayToBuffer(arr) {
  return Buffer.from(arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength));
}

async function extractEmbedding(audioBuffer) {
  const provider = config.voice?.provider || 'deepgram';
  if (provider === 'deepgram' && config.voice?.deepgramApiKey) {
    return extractEmbeddingDeepgram(audioBuffer);
  }
  return extractEmbeddingMock(audioBuffer);
}

async function extractEmbeddingDeepgram(audioBuffer) {
  const axios = require('axios');
  const response = await axios.post(
    'https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&utterances=true',
    audioBuffer,
    {
      headers: {
        Authorization: `Token ${config.voice.deepgramApiKey}`,
        'Content-Type': 'audio/ogg',
      },
      timeout: 60000,
    }
  );

  const utterances = response.data?.results?.utterances;
  if (!utterances || utterances.length === 0) {
    throw new Error('No utterances found in audio for speaker embedding');
  }

  const embeddings = utterances
    .filter(u => u.speaker_embedding)
    .map(u => new Float32Array(u.speaker_embedding));

  if (embeddings.length === 0) {
    throw new Error('Speaker embeddings not available from Deepgram');
  }

  const avg = new Float32Array(embeddings[0].length);
  for (const emb of embeddings) {
    for (let i = 0; i < emb.length; i++) avg[i] += emb[i];
  }
  for (let i = 0; i < avg.length; i++) avg[i] /= embeddings.length;
  return float32ArrayToBuffer(avg);
}

async function extractEmbeddingMock(audioBuffer) {
  const hash = crypto.createHash('sha256').update(audioBuffer).digest();
  const arr = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    arr[i] = (hash[i % 32] / 255 - 0.5) * 2;
  }
  return float32ArrayToBuffer(arr);
}

async function enrollVoiceProfile(userId, audioBuffer) {
  const embedding = await extractEmbedding(audioBuffer);
  const existing = await prisma.voiceProfile.findUnique({ where: { userId } });

  if (existing) {
    const oldEmb = bufferToFloat32Array(existing.embedding);
    const newEmb = bufferToFloat32Array(embedding);
    const count = existing.enrollmentCount + 1;
    const combined = new Float32Array(oldEmb.length);
    for (let i = 0; i < oldEmb.length; i++) {
      combined[i] = (oldEmb[i] * existing.enrollmentCount + newEmb[i]) / count;
    }
    return prisma.voiceProfile.update({
      where: { userId },
      data: {
        embedding: float32ArrayToBuffer(combined),
        enrollmentCount: count,
      },
    });
  }

  return prisma.voiceProfile.create({
    data: { userId, embedding },
  });
}

async function verifySpeaker(userId, audioBuffer, options = {}) {
  const threshold = options.threshold ?? config.voice?.speakerConfidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;

  const profile = await prisma.voiceProfile.findUnique({ where: { userId } });
  if (!profile) {
    return { verified: false, reason: 'no_profile', confidence: 0, requiresEnrollment: true };
  }

  const incomingEmb = await extractEmbedding(audioBuffer);
  const storedEmb = bufferToFloat32Array(profile.embedding);
  const incomingArr = bufferToFloat32Array(incomingEmb);

  if (!storedEmb || !incomingArr || storedEmb.length !== incomingArr.length) {
    return { verified: false, reason: 'embedding_mismatch', confidence: 0 };
  }

  const confidence = cosineSimilarity(storedEmb, incomingArr);
  const verified = confidence >= threshold;

  if (verified) {
    await prisma.voiceProfile.update({
      where: { userId },
      data: { lastVerifiedAt: new Date() },
    });
  }

  return { verified, confidence, threshold, reason: verified ? 'match' : 'below_threshold' };
}

async function antiSpoofingCheck(audioBuffer, _options = {}) {
  const checks = [];
  let riskScore = 0;

  const durationSec = audioBuffer.length / 16000 / 2;
  if (durationSec < 1.0) {
    checks.push({ check: 'duration', passed: false, detail: 'Audio too short for reliable verification' });
    riskScore += 50;
  } else {
    checks.push({ check: 'duration', passed: true, detail: `Duration: ${durationSec.toFixed(2)}s` });
  }

  let sum = 0, sumSq = 0;
  const samples = new Int16Array(audioBuffer.buffer, audioBuffer.byteOffset, audioBuffer.byteLength / 2);
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] / 32768;
    sum += v;
    sumSq += v * v;
  }
  const mean = sum / samples.length;
  const variance = sumSq / samples.length - mean * mean;
  const rms = Math.sqrt(variance);

  if (rms < 0.01) {
    checks.push({ check: 'energy', passed: false, detail: 'Audio energy too low (likely silence/noise)' });
    riskScore += 40;
  } else {
    checks.push({ check: 'energy', passed: true, detail: `RMS: ${rms.toFixed(4)}` });
  }

  if (rms > 0.95) {
    checks.push({ check: 'clipping', passed: false, detail: 'Audio appears clipped/distorted' });
    riskScore += 40;
  } else {
    checks.push({ check: 'clipping', passed: true, detail: 'No clipping detected' });
  }

  let zeroCrossings = 0;
  for (let i = 1; i < samples.length; i++) {
    if ((samples[i] >= 0) !== (samples[i - 1] >= 0)) zeroCrossings++;
  }
  const zcr = zeroCrossings / samples.length;
  if (zcr < 0.01 || zcr > 0.5) {
    checks.push({ check: 'zero_crossing', passed: false, detail: `ZCR ${zcr.toFixed(4)} outside speech range` });
    riskScore += 15;
  } else {
    checks.push({ check: 'zero_crossing', passed: true, detail: `ZCR: ${zcr.toFixed(4)}` });
  }

  const passed = riskScore < 40;
  return { passed, riskScore, checks, detail: passed ? 'Anti-spoofing checks passed' : 'Potential spoofing detected' };
}

async function verifyVoiceCommand(userId, audioBuffer, options = {}) {
  const antiSpoof = await antiSpoofingCheck(audioBuffer);
  if (!antiSpoof.passed) {
    return { verified: false, reason: 'anti_spoofing_failed', antiSpoof, confidence: 0 };
  }

  const speaker = await verifySpeaker(userId, audioBuffer, options);
  if (!speaker.verified) {
    return { verified: false, reason: speaker.reason, antiSpoof, confidence: speaker.confidence };
  }

  return { verified: true, reason: 'verified', antiSpoof, confidence: speaker.confidence };
}

module.exports = {
  extractEmbedding,
  enrollVoiceProfile,
  verifySpeaker,
  antiSpoofingCheck,
  verifyVoiceCommand,
  cosineSimilarity,
  DEFAULT_CONFIDENCE_THRESHOLD,
  MIN_ENROLLMENT_SAMPLES,
};