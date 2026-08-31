#!/usr/bin/env node
// generate-deployment-manifest.js
// Generates a signed deployment manifest for SendAm deployments.
// Usage:
//   node scripts/generate-deployment-manifest.js --environment production --release v1.2.3 --output deployment-manifest.json
//   MANIFEST_SIGNING_SECRET=<secret> node scripts/generate-deployment-manifest.js

const { buildManifest, signManifest, writeManifest } = require('../src/config/deploymentManifest');

const parseArgs = () => {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--environment' || args[i] === '-e') options.environment = args[++i];
    else if (args[i] === '--release' || args[i] === '-r') options.release = args[++i];
    else if (args[i] === '--output' || args[i] === '-o') options.output = args[++i];
    else if (args[i] === '--signed-by') options.signedBy = args[++i];
    else if (args[i] === '--help' || args[i] === '-h') {
      console.log('Usage: node scripts/generate-deployment-manifest.js [options]');
      console.log('Options:');
      console.log('  -e, --environment <env>   Target environment (development, staging, production)');
      console.log('  -r, --release <version>   Release version or git SHA');
      console.log('  -o, --output <path>       Output file path (default: deployment-manifest.json)');
      console.log('  --signed-by <name>        Name of the person/system signing the manifest');
      console.log('  -h, --help                Show this help');
      process.exit(0);
    }
  }
  return options;
};

const main = () => {
  const options = parseArgs();

  if (!options.environment) {
    console.error('Error: --environment is required.');
    process.exit(1);
  }

  const signingSecret = process.env.MANIFEST_SIGNING_SECRET;
  if (!signingSecret) {
    console.error('Error: MANIFEST_SIGNING_SECRET environment variable is required to sign the manifest.');
    process.exit(1);
  }

  try {
    const manifest = buildManifest({
      environment: options.environment,
      release: options.release,
      signedBy: options.signedBy,
    });
    const signed = signManifest(manifest, signingSecret);
    const outputPath = writeManifest(signed, options.output);
    console.log(`Deployment manifest written to: ${outputPath}`);
    console.log(`Environment: ${signed.environment}`);
    console.log(`Release: ${signed.release}`);
    console.log(`Config hash: ${signed.configHash}`);
    console.log(`Signature: ${signed.signature.value.slice(0, 16)}...`);
    console.log(`Signed at: ${signed.signature.signedAt}`);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
};

if (require.main === module) {
  main();
}

module.exports = { buildManifest, signManifest, writeManifest };
