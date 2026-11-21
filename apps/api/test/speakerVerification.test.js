const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const mockVoiceProfile = {
  findUnique: async () => null,
  create: async (data) => ({ ...data.data, id: 'vp-1' }),
  update: async (data) => ({ ...data.data, id: 'vp-1' }),
};

const prisma = {
  voiceProfile: mockVoiceProfile,
};

require.cache[require.resolve('../src/common/prisma')] = {
  exports: prisma,
};

const {
  cosineSimilarity,
  extractEmbedding,
  enrollVoiceProfile,
  verifySpeaker,
  antiSpoofingCheck,
  verifyVoiceCommand,
  DEFAULT_CONFIDENCE_THRESHOLD,
} = require('../src/voice/speakerVerification');

const mockUserId = 'test-user-speaker-1';

function makeAudioBuffer(durationSec = 2, sampleRate = 16000, pattern = 'speech') {
  const samples = Math.floor(durationSec * sampleRate);
  const buf = Buffer.alloc(samples * 2);
  const view = new Int16Array(buf.buffer);
  for (let i = 0; i < samples; i++) {
    let v = 0;
    if (pattern === 'speech') {
      v = Math.sin(2 * Math.PI * 440 * i / sampleRate) * 0.3;
      v += Math.sin(2 * Math.PI * 880 * i / sampleRate) * 0.1;
      v += (Math.random() - 0.5) * 0.05;
    } else if (pattern === 'silence') {
      v = (Math.random() - 0.5) * 0.001;
    } else if (pattern === 'noise') {
      v = (Math.random() - 0.5) * 0.5;
    } else if (pattern === 'clipped') {
      v = Math.sin(2 * Math.PI * 440 * i / sampleRate) * 2.0;
    }
    view[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  }
  return buf;
}

beforeEach(() => {
  mockVoiceProfile.findUnique = async () => null;
  mockVoiceProfile.create = async (data) => ({ ...data.data, id: 'vp-1' });
  mockVoiceProfile.update = async (data) => ({ ...data.data, id: 'vp-1' });
});

afterEach(() => {
  mockVoiceProfile.findUnique = async () => null;
  mockVoiceProfile.create = async (data) => ({ ...data.data, id: 'vp-1' });
  mockVoiceProfile.update = async (data) => ({ ...data.data, id: 'vp-1' });
});

test('cosineSimilarity returns 1 for identical vectors', () => {
  const a = new Float32Array([1, 2, 3]);
  const b = new Float32Array([1, 2, 3]);
  assert.equal(cosineSimilarity(a, b), 1);
});

test('cosineSimilarity returns -1 for opposite vectors', () => {
  const a = new Float32Array([1, 2, 3]);
  const b = new Float32Array([-1, -2, -3]);
  assert.equal(cosineSimilarity(a, b), -1);
});

test('cosineSimilarity returns 0 for orthogonal vectors', () => {
  const a = new Float32Array([1, 0, 0]);
  const b = new Float32Array([0, 1, 0]);
  assert.equal(cosineSimilarity(a, b), 0);
});

test('cosineSimilarity handles zero vectors', () => {
  const a = new Float32Array([0, 0, 0]);
  const b = new Float32Array([1, 2, 3]);
  assert.equal(cosineSimilarity(a, b), 0);
});

test('extractEmbedding returns a buffer for mock provider', async () => {
  const audio = makeAudioBuffer(1);
  const emb = await extractEmbedding(audio);
  assert.ok(Buffer.isBuffer(emb));
  assert.ok(emb.length > 0);
});

test('enrollVoiceProfile creates a new profile', async () => {
  const audio = makeAudioBuffer(2);
  const profile = await enrollVoiceProfile(mockUserId, audio);
  assert.equal(profile.userId, mockUserId);
  assert.ok(Buffer.isBuffer(profile.embedding));
  assert.equal(profile.enrollmentCount, 1);
});

test('enrollVoiceProfile updates existing profile with averaged embedding', async () => {
  const audio1 = makeAudioBuffer(2);
  await enrollVoiceProfile(mockUserId, audio1);

  prisma.voiceProfile.findUnique = async () => ({
    userId: mockUserId,
    embedding: Buffer.from(new Float32Array(256).fill(0.5).buffer),
    enrollmentCount: 1,
  });

  const audio2 = makeAudioBuffer(2);
  const profile = await enrollVoiceProfile(mockUserId, audio2);
  assert.equal(profile.enrollmentCount, 2);
});

test('verifySpeaker returns requiresEnrollment when no profile exists', async () => {
  const audio = makeAudioBuffer(2);
  const result = await verifySpeaker(mockUserId, audio);
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'no_profile');
  assert.equal(result.requiresEnrollment, true);
});

test('verifySpeaker returns verified=true for matching embeddings', async () => {
  const embedding = new Float32Array(256).fill(0.5);
  prisma.voiceProfile.findUnique = async () => ({
    userId: mockUserId,
    embedding: Buffer.from(embedding.buffer),
    enrollmentCount: 3,
  });

  const audio = makeAudioBuffer(2);
  const result = await verifySpeaker(mockUserId, audio, { threshold: 0.5 });
  assert.equal(result.verified, true);
  assert.ok(result.confidence > 0.5);
});

test('verifySpeaker returns verified=false for non-matching embeddings', async () => {
  const embedding = new Float32Array(256).fill(0.5);
  prisma.voiceProfile.findUnique = async () => ({
    userId: mockUserId,
    embedding: Buffer.from(embedding.buffer),
    enrollmentCount: 3,
  });

  const audio = makeAudioBuffer(2, 16000, 'noise');
  const result = await verifySpeaker(mockUserId, audio, { threshold: 0.75 });
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'below_threshold');
});

test('antiSpoofingCheck passes for normal speech audio', async () => {
  const audio = makeAudioBuffer(2, 16000, 'speech');
  const result = await antiSpoofingCheck(audio);
  assert.equal(result.passed, true);
  assert.ok(result.riskScore < 40);
  assert.ok(result.checks.some(c => c.check === 'duration' && c.passed));
  assert.ok(result.checks.some(c => c.check === 'energy' && c.passed));
});

test('antiSpoofingCheck fails for too-short audio', async () => {
  const audio = makeAudioBuffer(0.5, 16000, 'speech');
  const result = await antiSpoofingCheck(audio);
  assert.equal(result.passed, false);
  assert.ok(result.riskScore >= 30);
  assert.ok(result.checks.some(c => c.check === 'duration' && !c.passed));
});

test('antiSpoofingCheck fails for silence', async () => {
  const audio = makeAudioBuffer(2, 16000, 'silence');
  const result = await antiSpoofingCheck(audio);
  assert.equal(result.passed, false);
  assert.ok(result.riskScore >= 25);
  assert.ok(result.checks.some(c => c.check === 'energy' && !c.passed));
});

test('antiSpoofingCheck fails for clipped audio', async () => {
  const audio = makeAudioBuffer(2, 16000, 'clipped');
  const result = await antiSpoofingCheck(audio);
  assert.equal(result.passed, false);
  assert.ok(result.riskScore >= 20);
  assert.ok(result.checks.some(c => c.check === 'clipping' && !c.passed));
});

test('verifyVoiceCommand fails fast on anti-spoofing failure', async () => {
  const audio = makeAudioBuffer(0.5, 16000, 'silence');
  prisma.voiceProfile.findUnique = async () => ({
    userId: mockUserId,
    embedding: Buffer.from(new Float32Array(256).fill(0.5).buffer),
    enrollmentCount: 3,
  });

  const result = await verifyVoiceCommand(mockUserId, audio);
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'anti_spoofing_failed');
  assert.ok(result.antiSpoof);
});

test('verifyVoiceCommand returns verified for clean matching audio', async () => {
  const embedding = new Float32Array(256).fill(0.5);
  prisma.voiceProfile.findUnique = async () => ({
    userId: mockUserId,
    embedding: Buffer.from(embedding.buffer),
    enrollmentCount: 3,
  });

  const audio = makeAudioBuffer(2, 16000, 'speech');
  const result = await verifyVoiceCommand(mockUserId, audio, { threshold: 0.5 });
  assert.equal(result.verified, true);
  assert.ok(result.confidence > 0.5);
  assert.ok(result.antiSpoof.passed);
});

test('DEFAULT_CONFIDENCE_THRESHOLD is 0.75', () => {
  assert.equal(DEFAULT_CONFIDENCE_THRESHOLD, 0.75);
});