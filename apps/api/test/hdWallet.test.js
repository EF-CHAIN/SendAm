'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const hd = require('../src/wallet/hdWallet');

describe('Deterministic Key Derivation (BIP-44 / SLIP-0010 / SEP-0005) (#966)', () => {
  describe('SEP-0005 Official Test Vectors', () => {
    // --- Test 1 (12 words, empty passphrase) ---
    const test1 = {
      mnemonic: 'illness spike retreat truth genius clock brain pass fit cave bargain toe',
      passphrase: '',
      seed: 'e4a5a632e70943ae7f07659df1332160937fad82587216a4c64315a0fb39497ee4a01f76ddab4cba68147977f3a147b6ad584c41808e8238a07f6cc4b582f186',
      intermediateKey: 'e0eec84fe165cd427cb7bc9b6cfdef0555aa1cb6f9043ff1fe986c3c8ddd22e3',
      accounts: [
        { index: 0, public: 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6', secret: 'SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN' },
        { index: 1, public: 'GBAW5XGWORWVFE2XTJYDTLDHXTY2Q2MO73HYCGB3XMFMQ562Q2W2GJQX', secret: 'SCEPFFWGAG5P2VX5DHIYK3XEMZYLTYWIPWYEKXFHSK25RVMIUNJ7CTIS' },
        { index: 2, public: 'GAY5PRAHJ2HIYBYCLZXTHID6SPVELOOYH2LBPH3LD4RUMXUW3DOYTLXW', secret: 'SDAILLEZCSA67DUEP3XUPZJ7NYG7KGVRM46XA7K5QWWUIGADUZCZWTJP' },
        { index: 3, public: 'GAOD5NRAEORFE34G5D4EOSKIJB6V4Z2FGPBCJNQI6MNICVITE6CSYIAE', secret: 'SBMWLNV75BPI2VB4G27RWOMABVRTSSF7352CCYGVELZDSHCXWCYFKXIX' },
        { index: 4, public: 'GBCUXLFLSL2JE3NWLHAWXQZN6SQC6577YMAU3M3BEMWKYPFWXBSRCWV4', secret: 'SCPCY3CEHMOP2TADSV2ERNNZBNHBGP4V32VGOORIEV6QJLXD5NMCJUXI' },
        { index: 5, public: 'GBRQY5JFN5UBG5PGOSUOL4M6D7VRMAYU6WW2ZWXBMCKB7GPT3YCBU2XZ', secret: 'SCK27SFHI3WUDOEMJREV7ZJQG34SCBR6YWCE6OLEXUS2VVYTSNGCRS6X' },
        { index: 6, public: 'GBY27SJVFEWR3DUACNBSMJB6T4ZPR4C7ZXSTHT6GMZUDL23LAM5S2PQX', secret: 'SDJ4WDPOQAJYR3YIAJOJP3E6E4BMRB7VZ4QAEGCP7EYVDW6NQD3LRJMZ' },
        { index: 7, public: 'GAY7T23Z34DWLSTEAUKVBPHHBUE4E3EMZBAQSLV6ZHS764U3TKUSNJOF', secret: 'SA3HXJUCE2N27TBIZ5JRBLEBF3TLPQEBINP47E6BTMIWW2RJ5UKR2B3L' },
        { index: 8, public: 'GDJTCF62UUYSAFAVIXHPRBR4AUZV6NYJR75INVDXLLRZLZQ62S44443R', secret: 'SCD5OSHUUC75MSJG44BAT3HFZL2HZMMQ5M4GPDL7KA6HJHV3FLMUJAME' },
        { index: 9, public: 'GBTVYYDIYWGUQUTKX6ZMLGSZGMTESJYJKJWAATGZGITA25ZB6T5REF44', secret: 'SCJGVMJ66WAUHQHNLMWDFGY2E72QKSI3XGSBYV6BANDFUFE7VY4XNXXR' },
      ],
    };

    test('Test 1: derives identical BIP-39 binary seed from mnemonic', () => {
      const derivedSeed = hd.mnemonicToSeed(test1.mnemonic, test1.passphrase);
      assert.equal(derivedSeed.toString('hex'), test1.seed);
    });

    test("Test 1: derives correct intermediate m/44'/148' key node", () => {
      const node = hd.derivePath(test1.seed, "m/44'/148'");
      assert.equal(node.key.toString('hex'), test1.intermediateKey);
    });

    test('Test 1: matches all 10 derived Stellar account keypairs (0 to 9)', () => {
      for (const expected of test1.accounts) {
        const kp = hd.deriveStellarKeypair(test1.seed, expected.index);
        assert.equal(kp.publicKey(), expected.public, `Public key mismatch for account ${expected.index}`);
        assert.equal(kp.secret(), expected.secret, `Secret key mismatch for account ${expected.index}`);

        // Direct from mnemonic helper
        const kpDirect = hd.deriveFromMnemonic(test1.mnemonic, test1.passphrase, expected.index);
        assert.equal(kpDirect.publicKey(), expected.public);
        assert.equal(kpDirect.secret(), expected.secret);
      }
    });

    // --- Test 2 (15 words) ---
    const test2 = {
      mnemonic: 'resource asthma orphan phone ice canvas fire useful arch jewel impose vague theory cushion top',
      seed: '7b36d4e725b48695c3ffd2b4b317d5552cb157c1a26c46d36a05317f0d3053eb8b3b6496ba39ebd9312d10e3f9937b47a6790541e7c577da027a564862e92811',
      intermediateKey: '2e5d4e6b54a4b96c5e887c9ec92f619a3c134d8b1059dcef15c1a9b228ae3751',
      accounts: [
        { index: 0, public: 'GAVXVW5MCK7Q66RIBWZZKZEDQTRXWCZUP4DIIFXCCENGW2P6W4OA34RH', secret: 'SAKS7I2PNDBE5SJSUSU2XLJ7K5XJ3V3K4UDFAHMSBQYPOKE247VHAGDB' },
        { index: 1, public: 'GDFCYVCICATX5YPJUDS22KM2GW5QU2KKSPPPT2IC5AQIU6TP3BZSLR5K', secret: 'SAZ2H5GLAVWCUWNPQMB6I3OHRI63T2ACUUAWSH7NAGYYPXGIOPLPW3Q4' },
      ],
    };

    test('Test 2: derives correct seed, intermediate key, and accounts', () => {
      const derivedSeed = hd.mnemonicToSeed(test2.mnemonic);
      assert.equal(derivedSeed.toString('hex'), test2.seed);

      const intermediate = hd.derivePath(test2.seed, "m/44'/148'");
      assert.equal(intermediate.key.toString('hex'), test2.intermediateKey);

      for (const expected of test2.accounts) {
        const kp = hd.deriveStellarKeypair(test2.seed, expected.index);
        assert.equal(kp.publicKey(), expected.public);
        assert.equal(kp.secret(), expected.secret);
      }
    });

    // --- Test 3 (24 words) ---
    const test3 = {
      mnemonic: 'bench hurt jump file august wise shallow faculty impulse spring exact slush thunder author capable act festival slice deposit sauce coconut afford frown better',
      seed: '937ae91f6ab6f12461d9936dfc1375ea5312d097f3f1eb6fed6a82fbe38c85824da8704389831482db0433e5f6c6c9700ff1946aa75ad8cc2654d6e40f567866',
      intermediateKey: 'df474e0dc2711089b89af6b089aceeb77e73120e9f895bd330a36fa952835ea8',
      accounts: [
        { index: 0, public: 'GC3MMSXBWHL6CPOAVERSJITX7BH76YU252WGLUOM5CJX3E7UCYZBTPJQ', secret: 'SAEWIVK3VLNEJ3WEJRZXQGDAS5NVG2BYSYDFRSH4GKVTS5RXNVED5AX7' },
        { index: 1, public: 'GB3MTYFXPBZBUINVG72XR7AQ6P2I32CYSXWNRKJ2PV5H5C7EAM5YYISO', secret: 'SBKSABCPDWXDFSZISAVJ5XKVIEWV4M5O3KBRRLSPY3COQI7ZP423FYB4' },
      ],
    };

    test('Test 3: 24-word mnemonic test vectors match', () => {
      const derivedSeed = hd.mnemonicToSeed(test3.mnemonic);
      assert.equal(derivedSeed.toString('hex'), test3.seed);

      const intermediate = hd.derivePath(test3.seed, "m/44'/148'");
      assert.equal(intermediate.key.toString('hex'), test3.intermediateKey);

      for (const expected of test3.accounts) {
        const kp = hd.deriveStellarKeypair(test3.seed, expected.index);
        assert.equal(kp.publicKey(), expected.public);
        assert.equal(kp.secret(), expected.secret);
      }
    });

    // --- Test 4 (24 words + passphrase) ---
    const test4 = {
      mnemonic: 'cable spray genius state float twenty onion head street palace net private method loan turn phrase state blanket interest dry amazing dress blast tube',
      passphrase: 'p4ssphr4se',
      seed: 'd425d39998fb42ce4cf31425f0eaec2f0a68f47655ea030d6d26e70200d8ff8bd4326b4bdf562ea8640a1501ae93ccd0fd7992116da5dfa24900e570a742a489',
      intermediateKey: 'c83c61dc97d37832f0f20e258c3ba4040a258800fd14abaff124a4dee114b17e',
      accounts: [
        { index: 0, public: 'GDAHPZ2NSYIIHZXM56Y36SBVTV5QKFIZGYMMBHOU53ETUSWTP62B63EQ', secret: 'SAFWTGXVS7ELMNCXELFWCFZOPMHUZ5LXNBGUVRCY3FHLFPXK4QPXYP2X' },
        { index: 1, public: 'GDY47CJARRHHL66JH3RJURDYXAMIQ5DMXZLP3TDAUJ6IN2GUOFX4OJOC', secret: 'SBQPDFUGLMWJYEYXFRM5TQX3AX2BR47WKI4FDS7EJQUSEUUVY72MZPJF' },
      ],
    };

    test('Test 4: handles non-empty BIP-39 passphrase', () => {
      const derivedSeed = hd.mnemonicToSeed(test4.mnemonic, test4.passphrase);
      assert.equal(derivedSeed.toString('hex'), test4.seed);

      const intermediate = hd.derivePath(test4.seed, "m/44'/148'");
      assert.equal(intermediate.key.toString('hex'), test4.intermediateKey);

      for (const expected of test4.accounts) {
        const kp = hd.deriveStellarKeypair(test4.seed, expected.index);
        assert.equal(kp.publicKey(), expected.public);
        assert.equal(kp.secret(), expected.secret);
      }
    });

    // --- Test 5 (All-zero entropy) ---
    const test5 = {
      mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      seed: '5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4',
      intermediateKey: '03df7921b4f789040e361d07d5e4eddad277c376350d7b5d585400a0ef18f2f5',
      accounts: [
        { index: 0, public: 'GB3JDWCQJCWMJ3IILWIGDTQJJC5567PGVEVXSCVPEQOTDN64VJBDQBYX', secret: 'SBUV3MRWKNS6AYKZ6E6MOUVF2OYMON3MIUASWL3JLY5E3ISDJFELYBRZ' },
        { index: 1, public: 'GDVSYYTUAJ3ACHTPQNSTQBDQ4LDHQCMNY4FCEQH5TJUMSSLWQSTG42MV', secret: 'SCHDCVCWGAKGIMTORV6K5DYYV3BY4WG3RA4M6MCBGJLHUCWU2MC6DL66' },
      ],
    };

    test('Test 5: zero-entropy test vector', () => {
      const derivedSeed = hd.mnemonicToSeed(test5.mnemonic);
      assert.equal(derivedSeed.toString('hex'), test5.seed);

      const intermediate = hd.derivePath(test5.seed, "m/44'/148'");
      assert.equal(intermediate.key.toString('hex'), test5.intermediateKey);

      for (const expected of test5.accounts) {
        const kp = hd.deriveStellarKeypair(test5.seed, expected.index);
        assert.equal(kp.publicKey(), expected.public);
        assert.equal(kp.secret(), expected.secret);
      }
    });
  });

  describe('Input Validation and Security Guarantees', () => {
    test('rejects non-hardened path derivation for Ed25519 per SLIP-0010', () => {
      const seed = Buffer.alloc(64, 0xaa);
      assert.throws(
        () => hd.derivePath(seed, 'm/44/148/0'),
        /does not allow non-hardened child derivation/
      );
      assert.throws(
        () => hd.derivePath(seed, "m/44'/148'/0"),
        /does not allow non-hardened child derivation/
      );
    });

    test('rejects short or invalid binary seeds', () => {
      assert.throws(() => hd.normalizeSeed(Buffer.alloc(10)), /Seed must be at least 16 bytes/);
      assert.throws(() => hd.normalizeSeed('1234'), /valid hex string/);
      assert.throws(() => hd.normalizeSeed(null), /TypeError/);
    });

    test('rejects invalid account indices', () => {
      const seed = Buffer.alloc(64, 0xbb);
      assert.throws(() => hd.deriveStellarKeypair(seed, -1), /TypeError/);
      assert.throws(() => hd.deriveStellarKeypair(seed, '0'), /TypeError/);
      assert.throws(() => hd.deriveStellarKeypair(seed, 1.5), /TypeError/);
    });

    test('rejects invalid mnemonic input', () => {
      assert.throws(() => hd.mnemonicToSeed(''), /TypeError/);
      assert.throws(() => hd.mnemonicToSeed(null), /TypeError/);
    });
  });
});
