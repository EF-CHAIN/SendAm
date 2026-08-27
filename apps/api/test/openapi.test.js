const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { validateOpenApiSpec } = require('../scripts/validate-openapi');

describe('OpenAPI Contract & Specification (#161)', () => {
  test('committed openapi.json is valid OpenAPI 3.0 specification', () => {
    const result = validateOpenApiSpec();
    assert.equal(result.valid, true, `OpenAPI validation errors: ${result.errors.join(', ')}`);
    assert.ok(result.pathsCount >= 10);
    assert.ok(result.schemasCount >= 5);
  });

  test('all endpoints documented in openapi.json have response schemas', () => {
    const specPath = path.join(__dirname, '../openapi.json');
    const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));

    for (const [route, methods] of Object.entries(spec.paths)) {
      for (const [method, details] of Object.entries(methods)) {
        assert.ok(details.responses, `Method ${method} on ${route} missing responses`);
        assert.ok(details.responses['200'] || details.responses['201'] || details.responses['503'], `Method ${method} on ${route} missing success/status response`);
      }
    }
  });

  test('ErrorEnvelope component schema has required properties', () => {
    const specPath = path.join(__dirname, '../openapi.json');
    const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
    const errSchema = spec.components.schemas.ErrorEnvelope;

    assert.ok(errSchema);
    assert.equal(errSchema.type, 'object');
    assert.ok(errSchema.properties.status);
    assert.ok(errSchema.properties.error);
  });
});
