import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TARGET_CURRENCIES, SOURCE_CURRENCIES } from '@/lib/currencyConstants.js';
import { GITHUB_URL } from '@/lib/links.js';

const html = readFileSync(resolve(__dirname, '../../index.html'), 'utf8');

function extractJsonLd(source) {
  const blocks = [
    ...source.matchAll(/<script\s+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g),
  ];
  return blocks.map((m) => m[1]);
}

const graph = () => JSON.parse(extractJsonLd(html)[0])['@graph'];
const byType = (type) => graph().find((node) => node['@type'] === type);

describe('index.html JSON-LD structured data', () => {
  it('ships exactly one parseable JSON-LD block with the schema.org context', () => {
    const blocks = extractJsonLd(html);
    expect(blocks).toHaveLength(1);
    const data = JSON.parse(blocks[0]);
    expect(data['@context']).toBe('https://schema.org');
    expect(Array.isArray(data['@graph'])).toBe(true);
  });

  it('describes the Organization identity', () => {
    const org = byType('Organization');
    expect(org.name).toBe('SendAm');
    expect(org.url).toMatch(/^https:\/\//);
    expect(org.logo).toMatch(/^https:\/\/.+\.png$/);
    expect(org.sameAs).toContain(GITHUB_URL);
  });

  it('lists an official support channel on the Organization', () => {
    const [contact] = byType('Organization').contactPoint;
    expect(contact['@type']).toBe('ContactPoint');
    expect(contact.contactType).toBe('customer support');
    expect(contact.url).toMatch(/^https:\/\//);
  });

  it('describes the FinancialService and links it to the Organization', () => {
    const service = byType('FinancialService');
    const org = byType('Organization');
    expect(service.serviceType).toMatch(/money transfer/i);
    expect(service.provider['@id']).toBe(org['@id']);
    expect(service.feesAndCommissionsSpecification).toBeTruthy();
  });

  it('keeps areaServed in sync with the calculator corridors', () => {
    const served = byType('FinancialService').areaServed.map((c) => c.name).sort();
    const corridors = TARGET_CURRENCIES.map((c) => c.country).sort();
    expect(served).toEqual(corridors);
  });

  it('keeps currenciesAccepted in sync with the supported source currencies', () => {
    const accepted = byType('FinancialService').currenciesAccepted.split(',').map((c) => c.trim());
    expect(accepted).toEqual(SOURCE_CURRENCIES.map((c) => c.code));
  });

  it('uses unique, absolute @id values', () => {
    const ids = graph().map((node) => node['@id']);
    expect(new Set(ids).size).toBe(ids.length);
    ids.forEach((id) => expect(id).toMatch(/^https:\/\//));
  });

  it('does not break out of the script element', () => {
    const [block] = extractJsonLd(html);
    expect(block).not.toMatch(/<\/script/i);
    expect(block).not.toMatch(/<!--/);
  });

  it('extractor returns nothing for markup without JSON-LD (failure mode)', () => {
    expect(extractJsonLd('<html><head></head></html>')).toEqual([]);
    expect(() => JSON.parse(extractJsonLd('<script type="application/ld+json">{oops</script>')[0])).toThrow();
  });
});
