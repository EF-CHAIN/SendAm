'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Validates the OpenAPI specification for SendAm REST API (#161).
 */
const validateOpenApiSpec = (specPath = path.join(__dirname, '../openapi.json')) => {
  if (!fs.existsSync(specPath)) {
    throw new Error(`OpenAPI spec file not found at ${specPath}`);
  }

  const content = fs.readFileSync(specPath, 'utf8');
  let spec;
  try {
    spec = JSON.parse(content);
  } catch (err) {
    throw new Error(`OpenAPI spec is not valid JSON: ${err.message}`);
  }

  const errors = [];

  if (!spec.openapi || !spec.openapi.startsWith('3.')) {
    errors.push('Missing or unsupported openapi version (expected 3.x)');
  }

  if (!spec.info || !spec.info.title || !spec.info.version) {
    errors.push('Missing required info fields (title, version)');
  }

  if (!spec.paths || typeof spec.paths !== 'object' || Object.keys(spec.paths).length === 0) {
    errors.push('Missing or empty paths object');
  }

  const schemaNames = new Set(Object.keys(spec.components?.schemas || {}));

  // Validate path items
  for (const [pathUrl, pathItem] of Object.entries(spec.paths || {})) {
    if (!pathUrl.startsWith('/')) {
      errors.push(`Invalid path route format: ${pathUrl}`);
    }

    for (const [method, operation] of Object.entries(pathItem)) {
      if (['get', 'post', 'put', 'patch', 'delete'].includes(method.toLowerCase())) {
        if (!operation.responses || Object.keys(operation.responses).length === 0) {
          errors.push(`Missing responses for ${method.toUpperCase()} ${pathUrl}`);
        }

        // Validate $ref references in operations
        const strOp = JSON.stringify(operation);
        const refs = strOp.match(/"\$ref"\s*:\s*"#\/components\/schemas\/([^"]+)"/g) || [];
        for (const ref of refs) {
          const match = ref.match(/#\/components\/schemas\/([^"]+)/);
          if (match && !schemaNames.has(match[1])) {
            errors.push(`Unresolved schema reference ${match[1]} in ${method.toUpperCase()} ${pathUrl}`);
          }
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    pathsCount: Object.keys(spec.paths || {}).length,
    schemasCount: schemaNames.size,
  };
};

const run = () => {
  try {
    const result = validateOpenApiSpec();
    if (!result.valid) {
      console.error('OpenAPI Validation Failed:');
      for (const err of result.errors) console.error(`  - ${err}`);
      process.exitCode = 1;
    } else {
      console.log(`✔ OpenAPI 3.0 specification valid! (${result.pathsCount} paths, ${result.schemasCount} schemas documented)`);
    }
  } catch (err) {
    console.error('OpenAPI Validation Error:', err.message);
    process.exitCode = 1;
  }
};

if (require.main === module) run();

module.exports = {
  validateOpenApiSpec,
};
