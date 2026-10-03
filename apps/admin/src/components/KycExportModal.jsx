import { useState } from "react";

/**
 * Modal to prompt operator for encryption passphrase and export options
 * before client-side encryption and download of KYC data.
 */
export default function KycExportModal({
  isOpen,
  onClose,
  onExport,
  exporting,
}) {
  const [passphrase, setPassphrase] = useState("");
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [exportFormat, setExportFormat] = useState("encrypted"); // 'encrypted' | 'plaintext_csv'
  const [error, setError] = useState("");

  if (!isOpen) return null;

  const handleSubmit = (e) => {
    e.preventDefault();
    setError("");

    if (exportFormat === "encrypted") {
      if (!passphrase || passphrase.length < 8) {
        setError(
          "Passphrase must be at least 8 characters long for secure encryption.",
        );
        return;
      }
      if (passphrase !== confirmPassphrase) {
        setError("Passphrases do not match.");
        return;
      }
    }

    onExport({
      format: exportFormat,
      passphrase: exportFormat === "encrypted" ? passphrase : null,
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="kyc-export-modal-title"
      data-testid="kyc-export-modal"
    >
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl dark:bg-gray-800">
        <h2
          id="kyc-export-modal-title"
          className="text-xl font-bold text-gray-900 dark:text-white mb-2"
        >
          Export KYC Data
        </h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          Client-side AES-256-GCM field-level encryption with PBKDF2 key
          derivation safeguards sensitive customer identification data on your
          device.
        </p>

        {error && (
          <div
            className="mb-4 p-3 bg-red-50 text-red-600 border border-red-200 rounded-lg text-sm"
            role="alert"
          >
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wider mb-1">
              Export Type
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setExportFormat("encrypted")}
                className={`py-2 px-3 text-xs font-medium rounded-lg border text-center transition-colors ${
                  exportFormat === "encrypted"
                    ? "border-indigo-600 bg-indigo-50 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300"
                    : "border-gray-200 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
                }`}
                data-testid="export-type-encrypted"
              >
                🔐 Encrypted (.sendam-enc)
              </button>
              <button
                type="button"
                onClick={() => setExportFormat("plaintext_csv")}
                className={`py-2 px-3 text-xs font-medium rounded-lg border text-center transition-colors ${
                  exportFormat === "plaintext_csv"
                    ? "border-indigo-600 bg-indigo-50 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300"
                    : "border-gray-200 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
                }`}
                data-testid="export-type-csv"
              >
                📄 Plain CSV
              </button>
            </div>
          </div>

          {exportFormat === "encrypted" && (
            <>
              <div>
                <label
                  htmlFor="kyc-passphrase"
                  className="block text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wider mb-1"
                >
                  Decryption Passphrase
                </label>
                <input
                  id="kyc-passphrase"
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder="Enter secret passphrase (min 8 chars)"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-white"
                  required
                  data-testid="kyc-export-passphrase"
                />
              </div>

              <div>
                <label
                  htmlFor="kyc-confirm-passphrase"
                  className="block text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wider mb-1"
                >
                  Confirm Passphrase
                </label>
                <input
                  id="kyc-confirm-passphrase"
                  type="password"
                  value={confirmPassphrase}
                  onChange={(e) => setConfirmPassphrase(e.target.value)}
                  placeholder="Confirm passphrase"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-white"
                  required
                  data-testid="kyc-export-confirm-passphrase"
                />
              </div>
            </>
          )}

          <div className="flex justify-end gap-3 pt-3 border-t border-gray-200 dark:border-gray-700">
            <button
              type="button"
              onClick={onClose}
              disabled={exporting}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
              data-testid="cancel-export-btn"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={exporting}
              className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50"
              data-testid="confirm-export-btn"
            >
              {exporting ? "Exporting & Encrypting…" : "Generate Export"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
