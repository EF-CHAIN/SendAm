const axios = require('axios');
const config = require('../config/env');
const logger = require('../utils/logger');
const { writeAuditLog } = require('../common/audit.service');

const normalizeName = (value) => String(value || '')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .trim()
  .replace(/\s+/g, ' ');

const soundex = (value) => {
  const name = normalizeName(value).replace(/\s/g, '');
  if (!name) return '';
  const codes = { b: '1', f: '1', p: '1', v: '1', c: '2', g: '2', j: '2', k: '2', q: '2', s: '2', x: '2', z: '2', d: '3', t: '3', l: '4', m: '5', n: '5', r: '6' };
  let previous = codes[name[0]] || '';
  let result = name[0].toUpperCase();
  for (const char of name.slice(1)) {
    const code = codes[char] || '';
    if (code && code !== previous) result += code;
    previous = code;
    if (result.length === 4) break;
  }
  return result.padEnd(4, '0');
};

const metaphone = (value) => {
  let word = normalizeName(value).replace(/\s/g, '').toUpperCase();
  if (!word) return '';
  word = word.replace(/^(KN|GN|PN|AE|WR)/, (prefix) => prefix.slice(1))
    .replace(/^WH/, 'W')
    .replace(/^X/, 'S')
    .replace(/MB$/, 'M');
  let result = '';
  for (let i = 0; i < word.length && result.length < 8; i += 1) {
    const char = word[i];
    const previous = word[i - 1] || '';
    const next = word[i + 1] || '';
    if (char === previous && char !== 'C') continue;
    if ('AEIOU'.includes(char)) {
      if (i === 0) result += char;
    } else if (char === 'B' && !(previous === 'M' && i === word.length - 1)) result += 'B';
    else if (char === 'C') result += next === 'H' ? (i += 1, 'X') : ('IEY'.includes(next) ? 'S' : 'K');
    else if ('DFJLMNR'.includes(char)) result += char;
    else if (char === 'G') result += next === 'H' ? '' : ('IEY'.includes(next) ? 'J' : 'K');
    else if (char === 'H' && !'CSPTG'.includes(previous) && 'AEIOU'.includes(next)) result += 'H';
    else if (char === 'K' && previous !== 'C') result += 'K';
    else if (char === 'P') result += next === 'H' ? (i += 1, 'F') : 'P';
    else if (char === 'Q') result += 'K';
    else if (char === 'S') result += next === 'H' ? (i += 1, 'X') : 'S';
    else if (char === 'T') result += next === 'H' ? (i += 1, '0') : ('IO'.includes(next) && word[i + 2] === 'N' ? 'X' : 'T');
    else if (char === 'V') result += 'F';
    else if (char === 'W' || char === 'Y') {
      if ('AEIOU'.includes(next)) result += char;
    } else if (char === 'X') result += 'KS';
    else if (char === 'Z') result += 'S';
  }
  return result;
};

const asList = (value) => (Array.isArray(value) ? value : value ? [value] : []);

const candidateNames = (entity) => {
  const properties = entity?.properties || {};
  const names = [entity?.caption, ...asList(properties.name), ...asList(properties.alias)];
  return names.map(normalizeName).filter(Boolean);
};

const isNameMatch = (searchedName, entity) => {
  const normalized = normalizeName(searchedName);
  const candidateSoundex = soundex(normalized);
  const candidateMetaphone = metaphone(normalized);
  const names = candidateNames(entity);
  const exact = names.some((name) => name === normalized);
  const phonetic = names.some((name) => (
    (candidateSoundex && soundex(name) === candidateSoundex)
    || (candidateMetaphone && metaphone(name) === candidateMetaphone)
  ));
  return { exact, phonetic };
};

const topicsFor = (entity) => [
  ...asList(entity?.properties?.topics),
  ...asList(entity?.properties?.datasets),
  ...asList(entity?.datasets),
].join(' ').toLowerCase();

const screenName = async (name, { axiosImpl = axios } = {}) => {
  const normalized = normalizeName(name);
  if (!normalized) return { status: 'not_screened', reason: 'No counterparty name is available.' };
  const { apiKey, baseUrl, timeoutMs } = config.compliance.sanctions;
  if (!apiKey) {
    if (config.isProduction) throw Object.assign(new Error('Sanctions screening is not configured.'), { statusCode: 503, code: 'SANCTIONS_UNAVAILABLE' });
    return { status: 'not_screened', reason: 'Sanctions provider is not configured.' };
  }

  const response = await axiosImpl.post(
    `${baseUrl.replace(/\/$/, '')}/match/default`,
    { queries: { q: { schema: 'Person', properties: { name: [name] } } } },
    {
      params: { threshold: 0.7, topics: ['sanction', 'sanction.linked', 'role.pep', 'role.rca'] },
      paramsSerializer: (params) => {
        const query = new URLSearchParams({ threshold: String(params.threshold) });
        params.topics.forEach((topic) => query.append('topics', topic));
        return query.toString();
      },
      headers: { Authorization: `ApiKey ${apiKey}` },
      timeout: timeoutMs,
    },
  );
  const matchResponse = response.data?.responses?.q;
  if (!Array.isArray(matchResponse?.results) || (matchResponse.status && matchResponse.status >= 400)) {
    throw new Error('OpenSanctions returned an invalid screening response.');
  }
  const results = matchResponse.results;
  const matches = results.flatMap((entity) => {
    const match = isNameMatch(name, entity);
    if (!match.exact && !match.phonetic) return [];
    const topics = topicsFor(entity);
    const sanctions = /sanction|ofac|unsc|eu_consolidated|uk_hmt/.test(topics);
    return [{
      name: String(entity.caption || entity.properties?.name?.[0] || '').slice(0, 200),
      exact: match.exact,
      phonetic: match.phonetic,
      status: sanctions ? 'blocked' : 'review',
      topics: topics.slice(0, 300),
    }];
  });
  const match = matches.find(({ status }) => status === 'blocked') || matches[0];
  return match
    ? { status: match.status, reason: `${match.status === 'blocked' ? 'Sanctions' : 'PEP'} match: ${match.name}`, match }
    : { status: 'cleared', reason: 'No sanctions or PEP match found.' };
};

const nameFromUser = (user, profile) => {
  const metadata = profile?.metadata || {};
  const applicant = metadata.applicant || metadata;
  return [applicant.firstName, applicant.middleName, applicant.lastName].filter(Boolean).join(' ').trim()
    || (!config.isProduction && user?.whatsappName)
    || '';
};

const createComplianceCase = async ({ tx, user, subject, result }) => {
  if (!tx.supportCase?.create) {
    throw Object.assign(new Error('Compliance case storage is unavailable.'), { statusCode: 503, code: 'COMPLIANCE_CASE_UNAVAILABLE' });
  }
  const caseNumber = `CASE-${Date.now().toString(36).toUpperCase()}-${require('crypto').randomBytes(3).toString('hex').toUpperCase()}`;
  const supportCase = await tx.supportCase.create({
    data: {
      caseNumber,
      userId: user.id,
      category: 'kyc_issue',
      title: `Sanctions screening ${result.status} for ${subject}`,
      description: `${result.reason} Transaction authorization has been suspended for compliance review.`,
      priority: result.status === 'blocked' ? 'critical' : 'high',
    },
  });
  await writeAuditLog({
    action: 'compliance.sanctions.match',
    entityType: 'SupportCase',
    entityId: supportCase.id,
    metadata: { subject, status: result.status, match: result.match || null },
  });
  return supportCase;
};

const screenPaymentParties = async ({ tx, sender, destination, recipientPhoneNumber }) => {
  let receiver = null;
  if (recipientPhoneNumber) {
    receiver = await tx.user.findUnique({ where: { phoneNumber: recipientPhoneNumber } });
  }
  if (!receiver && destination && tx.wallet?.findFirst) {
    const wallet = await tx.wallet.findFirst({
      where: { publicKey: destination },
      include: { user: true },
    });
    receiver = wallet?.user || null;
  }
  if (!receiver && config.isProduction) {
    throw Object.assign(new Error('A verified receiver name is required for sanctions screening.'), { statusCode: 403, code: 'SANCTIONS_NAME_REQUIRED' });
  }
  const parties = [
    { type: 'sender', user: sender },
    ...(receiver ? [{ type: 'receiver', user: receiver }] : []),
  ];
  for (const party of parties) {
    let profile = null;
    if (tx.kycProfile?.findUnique) {
      profile = await tx.kycProfile.findUnique({ where: { userId: party.user.id } });
    }
    const name = nameFromUser(party.user, profile);
    if (!name) {
      if (config.isProduction) {
        throw Object.assign(new Error(`A verified name is required to screen the ${party.type}.`), { statusCode: 403, code: 'SANCTIONS_NAME_REQUIRED' });
      }
      continue;
    }
    let result;
    try {
      result = await screenName(name);
    } catch (error) {
      logger.error('sanctions_name_screening_failed', { userId: party.user.id, role: party.type, message: error.message });
      throw Object.assign(new Error('Sanctions screening is temporarily unavailable; this payment cannot be authorized.'), {
        statusCode: 503,
        code: 'SANCTIONS_UNAVAILABLE',
      });
    }
    if (result.status === 'blocked' || result.status === 'review') {
      await createComplianceCase({ tx, user: party.user, subject: party.type, result });
      throw Object.assign(new Error('This payment is suspended for compliance review.'), {
        statusCode: 403,
        code: 'SANCTIONS_REVIEW',
      });
    }
  }
};

module.exports = {
  normalizeName,
  soundex,
  metaphone,
  isNameMatch,
  screenName,
  screenPaymentParties,
};
