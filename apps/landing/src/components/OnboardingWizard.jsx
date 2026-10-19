import { useEffect, useRef, useState } from 'react';
import {
  Smartphone,
  Lock,
  Send,
  CheckCircle2,
  ArrowRight,
  ArrowLeft,
  RefreshCw,
  Sparkles,
  Camera,
  FileText,
  Trash2,
  UploadCloud,
} from 'lucide-react';
import { whatsappUrl } from '@/lib/links.js';

const ACCEPTED_DOC_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];
const MAX_DOCS = 3;

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const STEPS = [
  {
    id: 1,
    title: 'Phone Registration',
    subtitle: 'Link your WhatsApp number to an on-chain Stellar wallet',
    icon: Smartphone,
  },
  {
    id: 2,
    title: 'Create Security PIN',
    subtitle: 'Set a 4-digit PIN to authorize every payment confirmation',
    icon: Lock,
  },
  {
    id: 3,
    title: 'First Transfer Simulation',
    subtitle: 'Test sending instant cross-border funds over Stellar rails',
    icon: Send,
  },
];

export default function OnboardingWizard() {
  const [currentStep, setCurrentStep] = useState(1);
  const [phone, setPhone] = useState('+234 801 234 5678');
  const [pin, setPin] = useState(['', '', '', '']);
  const [transferAmount, setTransferAmount] = useState('25.00');
  const [recipient, setRecipient] = useState('+233 241 987 654');
  const [simulating, setSimulating] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [idDocs, setIdDocs] = useState([]);
  const [dragActive, setDragActive] = useState(false);
  const browseInputRef = useRef(null);
  const cameraInputRef = useRef(null);
  const nextDocIdRef = useRef(1);

  // Preview URLs are browser resources; release whatever is left on unmount.
  const idDocsRef = useRef(idDocs);
  useEffect(() => {
    idDocsRef.current = idDocs;
  }, [idDocs]);
  useEffect(
    () => () => {
      for (const doc of idDocsRef.current) {
        if (doc.previewUrl) URL.revokeObjectURL(doc.previewUrl);
      }
    },
    []
  );

  const addIdDocs = (fileList) => {
    const incoming = Array.from(fileList || []).filter((file) => ACCEPTED_DOC_TYPES.includes(file.type));
    if (incoming.length === 0) return;
    setIdDocs((docs) => {
      const room = Math.max(0, MAX_DOCS - docs.length);
      const added = incoming.slice(0, room).map((file) => ({
        id: nextDocIdRef.current++,
        name: file.name,
        size: file.size,
        type: file.type,
        previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
      }));
      return [...docs, ...added];
    });
  };

  const removeIdDoc = (id) => {
    setIdDocs((docs) => {
      const doc = docs.find((d) => d.id === id);
      if (doc?.previewUrl) URL.revokeObjectURL(doc.previewUrl);
      return docs.filter((d) => d.id !== id);
    });
  };

  const handleDrop = (event) => {
    event.preventDefault();
    setDragActive(false);
    addIdDocs(event.dataTransfer?.files);
  };

  const handlePinChange = (index, value) => {
    if (value.length > 1) value = value.slice(-1);
    const newPin = [...pin];
    newPin[index] = value;
    setPin(newPin);
  };

  const handleNext = () => {
    if (currentStep < 3) {
      setCurrentStep((s) => s + 1);
    } else {
      setSimulating(true);
      setTimeout(() => {
        setSimulating(false);
        setCompleted(true);
      }, 1200);
    }
  };

  const handlePrev = () => {
    if (currentStep > 1) {
      setCurrentStep((s) => s - 1);
      setCompleted(false);
    }
  };

  const handleReset = () => {
    setCurrentStep(1);
    setCompleted(false);
    setSimulating(false);
    setPin(['', '', '', '']);
  };

  return (
    <section id="demo-wizard" className="py-16 sm:py-24 bg-slate-50 border-y border-slate-200/60">
      <div className="container mx-auto px-4 sm:px-6 max-w-4xl">
        <div className="text-center max-w-2xl mx-auto mb-12">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold bg-primary/10 text-primary mb-3">
            <Sparkles className="w-3.5 h-3.5" />
            Interactive Experience
          </div>
          <h2 className="text-3xl font-extrabold text-slate-900 tracking-tight sm:text-4xl">
            Experience 3-step onboarding in 60 seconds
          </h2>
          <p className="mt-3 text-slate-600 text-base sm:text-lg">
            No crypto downloads, seed phrases, or gas fees. Test how SendAm turns any WhatsApp account into an instant Stellar payment wallet.
          </p>
        </div>

        {/* Wizard Container Card */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          {/* Step Indicator Header */}
          <div className="grid grid-cols-3 border-b border-slate-100 bg-slate-50/50">
            {STEPS.map((step) => {
              const isActive = currentStep === step.id;
              const isPast = currentStep > step.id || completed;
              return (
                <div
                  key={step.id}
                  className={`p-4 sm:p-5 flex items-center gap-3 transition-colors border-r last:border-r-0 border-slate-100 ${
                    isActive ? 'bg-white border-b-2 border-b-primary font-semibold text-primary' : 'text-slate-500'
                  }`}
                >
                  <div
                    className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-xs font-bold ${
                      isPast
                        ? 'bg-emerald-100 text-emerald-700'
                        : isActive
                        ? 'bg-primary text-white'
                        : 'bg-slate-200 text-slate-600'
                    }`}
                  >
                    {isPast ? <CheckCircle2 className="w-4 h-4" /> : step.id}
                  </div>
                  <div className="hidden sm:block text-left">
                    <div className="text-xs uppercase tracking-wider text-slate-400">Step {step.id}</div>
                    <div className={`text-sm ${isActive ? 'text-slate-900 font-bold' : 'text-slate-600'}`}>
                      {step.title}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Wizard Body */}
          <div className="p-6 sm:p-10 min-h-[320px] flex flex-col justify-between">
            {!completed ? (
              <div>
                {/* Step 1: Phone Registration */}
                {currentStep === 1 && (
                  <div className="space-y-6 animate-fade-in">
                    <div>
                      <h3 className="text-xl font-bold text-slate-900">Enter your WhatsApp phone number</h3>
                      <p className="text-sm text-slate-600 mt-1">
                        SendAm will automatically provision an on-chain non-custodial Stellar wallet tied to your phone number.
                      </p>
                    </div>
                    <div>
                      <label htmlFor="wizard-phone" className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-2">
                        WhatsApp Phone Number
                      </label>
                      <div className="relative max-w-md">
                        <Smartphone className="absolute left-3.5 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                        <input
                          id="wizard-phone"
                          type="text"
                          value={phone}
                          onChange={(e) => setPhone(e.target.value)}
                          className="w-full pl-11 pr-4 py-3 rounded-xl border border-slate-200 text-slate-900 font-medium focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition"
                          placeholder="+234 800 000 0000"
                        />
                      </div>
                    </div>
                    {/* Identity document upload */}
                    <div>
                      <span
                        id="wizard-id-docs-label"
                        className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-2"
                      >
                        Identity Document ({idDocs.length}/{MAX_DOCS})
                      </span>
                      <div
                        data-testid="id-doc-dropzone"
                        aria-labelledby="wizard-id-docs-label"
                        onDragOver={(event) => {
                          event.preventDefault();
                          setDragActive(true);
                        }}
                        onDragLeave={() => setDragActive(false)}
                        onDrop={handleDrop}
                        className={`rounded-xl border-2 border-dashed p-5 text-center transition-colors ${
                          dragActive ? 'border-primary bg-primary/5' : 'border-slate-200 bg-slate-50/60'
                        }`}
                      >
                        <UploadCloud className="w-7 h-7 mx-auto text-slate-400" aria-hidden="true" />
                        <p className="mt-2 text-sm text-slate-600">
                          Drag and drop a photo or PDF of your ID here, or
                        </p>
                        <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                          <button
                            type="button"
                            onClick={() => browseInputRef.current?.click()}
                            disabled={idDocs.length >= MAX_DOCS}
                            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-slate-200 bg-white text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 transition"
                          >
                            <FileText className="w-4 h-4" aria-hidden="true" />
                            Browse Files
                          </button>
                          <button
                            type="button"
                            onClick={() => cameraInputRef.current?.click()}
                            disabled={idDocs.length >= MAX_DOCS}
                            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-slate-200 bg-white text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 transition"
                          >
                            <Camera className="w-4 h-4" aria-hidden="true" />
                            Take Photo
                          </button>
                        </div>
                        <p className="mt-2 text-[11px] text-slate-400">
                          JPEG, PNG, WebP, GIF or PDF. Nothing is uploaded in this demo — previews stay on your device.
                        </p>
                        <input
                          ref={browseInputRef}
                          type="file"
                          accept="image/jpeg,image/png,image/webp,image/gif,application/pdf"
                          multiple
                          onChange={(event) => {
                            addIdDocs(event.target.files);
                            event.target.value = '';
                          }}
                          className="sr-only"
                          aria-label="Browse identity document files"
                        />
                        <input
                          ref={cameraInputRef}
                          type="file"
                          accept="image/*"
                          capture="environment"
                          onChange={(event) => {
                            addIdDocs(event.target.files);
                            event.target.value = '';
                          }}
                          className="sr-only"
                          aria-label="Take a photo of your identity document"
                        />
                      </div>

                      {idDocs.length > 0 && (
                        <ul className="mt-3 space-y-2" aria-label="Uploaded identity documents">
                          {idDocs.map((doc) => (
                            <li
                              key={doc.id}
                              className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-2.5"
                            >
                              {doc.previewUrl ? (
                                <img
                                  src={doc.previewUrl}
                                  alt={`Preview of ${doc.name}`}
                                  className="h-12 w-12 shrink-0 rounded-lg object-cover border border-slate-100"
                                />
                              ) : (
                                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
                                  <FileText className="w-6 h-6" aria-hidden="true" />
                                </span>
                              )}
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-sm font-medium text-slate-800">{doc.name}</span>
                                <span className="block text-xs text-slate-400">{formatFileSize(doc.size)}</span>
                              </span>
                              <button
                                type="button"
                                onClick={() => removeIdDoc(doc.id)}
                                aria-label={`Remove ${doc.name}`}
                                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-red-50 hover:text-red-600 transition"
                              >
                                <Trash2 className="w-4 h-4" aria-hidden="true" />
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>

                    <div className="p-4 bg-emerald-50/70 border border-emerald-200/60 rounded-xl flex items-start gap-3">
                      <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
                      <div className="text-xs text-emerald-800">
                        <span className="font-bold">Automated Stellar Provisioning:</span> When registered, a keypair is generated and automatically funded with starter testnet reserves and an active USDC trustline.
                      </div>
                    </div>
                  </div>
                )}

                {/* Step 2: PIN Creation */}
                {currentStep === 2 && (
                  <div className="space-y-6 animate-fade-in">
                    <div>
                      <h3 className="text-xl font-bold text-slate-900">Set your 4-digit security PIN</h3>
                      <p className="text-sm text-slate-600 mt-1">
                        Your PIN is encrypted with argon2id and is required before any payment is dispatched over the blockchain.
                      </p>
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-2">
                        4-Digit PIN
                      </label>
                      <div className="flex gap-3 max-w-xs">
                        {[0, 1, 2, 3].map((idx) => (
                          <input
                            key={idx}
                            id={`wizard-pin-${idx}`}
                            type="password"
                            maxLength={1}
                            value={pin[idx]}
                            onChange={(e) => handlePinChange(idx, e.target.value)}
                            className="w-12 h-14 text-center text-xl font-bold rounded-xl border border-slate-200 text-slate-900 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition"
                            placeholder="•"
                          />
                        ))}
                      </div>
                    </div>
                    <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl flex items-start gap-3">
                      <Lock className="w-5 h-5 text-primary shrink-0 mt-0.5" />
                      <div className="text-xs text-slate-600">
                        <span className="font-bold text-slate-900">Zero Trust Confirmation:</span> Every transaction sends an interactive WhatsApp confirmation requiring this PIN before Stellar network broadcast.
                      </div>
                    </div>
                  </div>
                )}

                {/* Step 3: First Transfer */}
                {currentStep === 3 && (
                  <div className="space-y-6 animate-fade-in">
                    <div>
                      <h3 className="text-xl font-bold text-slate-900">Simulate your first transfer</h3>
                      <p className="text-sm text-slate-600 mt-1">
                        Select an amount and recipient to test immediate cross-border settlement.
                      </p>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label htmlFor="wizard-amount" className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-2">
                          Transfer Amount (USDC)
                        </label>
                        <input
                          id="wizard-amount"
                          type="text"
                          value={transferAmount}
                          onChange={(e) => setTransferAmount(e.target.value)}
                          className="w-full px-4 py-3 rounded-xl border border-slate-200 text-slate-900 font-bold focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition"
                        />
                      </div>
                      <div>
                        <label htmlFor="wizard-recipient" className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-2">
                          Recipient Phone
                        </label>
                        <input
                          id="wizard-recipient"
                          type="text"
                          value={recipient}
                          onChange={(e) => setRecipient(e.target.value)}
                          className="w-full px-4 py-3 rounded-xl border border-slate-200 text-slate-900 font-medium focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition"
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              /* Completion State */
              <div className="text-center py-6 animate-fade-in space-y-4">
                <div className="w-16 h-16 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center mx-auto shadow-inner">
                  <CheckCircle2 className="w-10 h-10" />
                </div>
                <h3 className="text-2xl font-black text-slate-900 tracking-tight">
                  Simulated Onboarding & Transfer Complete!
                </h3>
                <p className="text-sm text-slate-600 max-w-md mx-auto">
                  Your phone number is active on the Stellar ledger. In live usage, you can now send payments in WhatsApp simply by typing:
                </p>
                <div className="inline-block bg-slate-900 text-emerald-400 font-mono text-sm px-4 py-2 rounded-lg shadow-sm">
                  send 25 usdc to {recipient}
                </div>
                <div className="pt-4 flex flex-col sm:flex-row items-center justify-center gap-3">
                  <a
                    href={whatsappUrl('create wallet')}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-primary font-semibold text-white hover:bg-emerald-600 shadow-md shadow-emerald-600/20 transition"
                  >
                    Start Real Wallet on WhatsApp
                    <ArrowRight className="w-4 h-4" />
                  </a>
                  <button
                    type="button"
                    onClick={handleReset}
                    className="inline-flex items-center gap-2 px-4 py-3 rounded-xl border border-slate-200 text-slate-700 font-medium hover:bg-slate-50 transition"
                  >
                    <RefreshCw className="w-4 h-4" />
                    Reset Simulation
                  </button>
                </div>
              </div>
            )}

            {/* Wizard Controls Footer */}
            {!completed && (
              <div className="flex items-center justify-between pt-8 mt-6 border-t border-slate-100">
                <button
                  type="button"
                  onClick={handlePrev}
                  disabled={currentStep === 1}
                  className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition ${
                    currentStep === 1
                      ? 'text-slate-300 cursor-not-allowed'
                      : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                  }`}
                >
                  <ArrowLeft className="w-4 h-4" />
                  Back
                </button>

                <button
                  type="button"
                  onClick={handleNext}
                  disabled={simulating}
                  className="inline-flex items-center gap-2 px-6 py-2.5 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-emerald-600 shadow-sm transition"
                >
                  {simulating ? (
                    <>
                      <RefreshCw className="w-4 h-4 animate-spin" />
                      Settling on Stellar...
                    </>
                  ) : currentStep === 3 ? (
                    <>
                      Execute Simulation
                      <Send className="w-4 h-4" />
                    </>
                  ) : (
                    <>
                      Next Step
                      <ArrowRight className="w-4 h-4" />
                    </>
                  )}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
