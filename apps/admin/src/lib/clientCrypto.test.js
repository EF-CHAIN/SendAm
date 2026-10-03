import { describe, it, expect } from "vitest";
import { deriveKey, encryptData, decryptData } from "./clientCrypto";

describe("clientCrypto utility", () => {
  const passphrase = "SuperSecretCompliancePassphrase123!";
  const testPayload = JSON.stringify({
    records: [
      {
        id: "kyc_1",
        name: "Alice Doe",
        ssn: "999-00-1234",
        bvn: "22334455667",
        phone: "+2348012345678",
      },
      {
        id: "kyc_2",
        name: "Bob Smith",
        nin: "12345678901",
        phone: "+2348087654321",
      },
    ],
  });

  it("derives a valid CryptoKey with PBKDF2", async () => {
    const salt = new Uint8Array(16);
    crypto.getRandomValues(salt);

    const key = await deriveKey(passphrase, salt);
    expect(key).toBeDefined();
    expect(key.algorithm.name).toBe("AES-GCM");
    expect(key.type).toBe("secret");
  });

  it("rejects invalid passphrase or salt during key derivation", async () => {
    const salt = new Uint8Array(16);
    await expect(deriveKey("", salt)).rejects.toThrow(/Passphrase is required/);
    await expect(deriveKey(null, salt)).rejects.toThrow(
      /Passphrase is required/,
    );
    await expect(deriveKey(passphrase, new Uint8Array(8))).rejects.toThrow(
      /at least 16 bytes/,
    );
  });

  it("encrypts plaintext payload and produces valid .sendam-enc structure with headers", async () => {
    const encrypted = await encryptData(testPayload, passphrase, {
      exportType: "KYC_DATA",
      totalRecords: 2,
    });

    expect(encrypted).toBeDefined();
    expect(encrypted.format).toBe("sendam-enc");
    expect(encrypted.version).toBe("1.0");
    expect(encrypted.algorithm).toBe("AES-256-GCM");
    expect(encrypted.kdf).toMatchObject({
      name: "PBKDF2",
      iterations: 100000,
      hash: "SHA-256",
    });
    expect(encrypted.kdf.salt).toBeTypeOf("string");
    expect(encrypted.iv).toBeTypeOf("string");
    expect(encrypted.ciphertext).toBeTypeOf("string");
    expect(encrypted.metadata).toMatchObject({
      exportType: "KYC_DATA",
      totalRecords: 2,
    });
    expect(encrypted.ciphertext).not.toContain("Alice Doe");
    expect(encrypted.ciphertext).not.toContain("22334455667");
  });

  it("decrypts encrypted payload back to identical plaintext with correct passphrase", async () => {
    const encrypted = await encryptData(testPayload, passphrase, {
      type: "test",
    });
    const decrypted = await decryptData(encrypted, passphrase);

    expect(decrypted).toBe(testPayload);
    const parsed = JSON.parse(decrypted);
    expect(parsed.records).toHaveLength(2);
    expect(parsed.records[0].name).toBe("Alice Doe");
  });

  it("supports decrypting stringified JSON payload", async () => {
    const encrypted = await encryptData(testPayload, passphrase);
    const stringified = JSON.stringify(encrypted);

    const decrypted = await decryptData(stringified, passphrase);
    expect(decrypted).toBe(testPayload);
  });

  it("fails decryption with wrong passphrase (AEAD authentication error)", async () => {
    const encrypted = await encryptData(testPayload, passphrase);

    await expect(
      decryptData(encrypted, "WrongPassphrase123!"),
    ).rejects.toThrow();
  });

  it("fails decryption when format is invalid", async () => {
    await expect(
      decryptData({ format: "unknown" }, passphrase),
    ).rejects.toThrow(/Unsupported encrypted payload format/);
  });
});
