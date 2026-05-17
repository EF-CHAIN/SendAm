'use client';
import { useState } from 'react';
import { createWallet, getBalance, sendXlm } from '@/lib/walletApi';
import Loader from '@/components/Loader';
import { Wallet, Search, Send, AlertCircle, CheckCircle2 } from 'lucide-react';

export default function WalletTestPage() {
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(null); // 'create' | 'balance' | 'send'
  const [result, setResult] = useState({ type: '', message: '', data: null });
  
  // Send form state
  const [sendAmount, setSendAmount] = useState('');
  const [sendDest, setSendDest] = useState('');

  const showResult = (type, message, data = null) => {
    setResult({ type, message, data });
    setTimeout(() => setResult({ type: '', message: '', data: null }), 8000);
  };

  const handleCreate = async () => {
    if (!phone) return showResult('error', 'Phone number is required');
    setLoading('create');
    try {
      const res = await createWallet({ phoneNumber: phone });
      showResult('success', res.message, res.data);
    } catch (err) {
      showResult('error', err.response?.data?.message || err.message);
    } finally {
      setLoading(null);
    }
  };

  const handleBalance = async () => {
    if (!phone) return showResult('error', 'Phone number is required');
    setLoading('balance');
    try {
      const res = await getBalance(phone);
      showResult('success', res.message, res.data);
    } catch (err) {
      showResult('error', err.response?.data?.message || err.message);
    } finally {
      setLoading(null);
    }
  };

  const handleSend = async (e) => {
    e.preventDefault();
    if (!phone || !sendAmount || !sendDest) return showResult('error', 'All fields are required');
    setLoading('send');
    try {
      const res = await sendXlm({ phoneNumber: phone, amount: sendAmount, destination: sendDest });
      showResult('success', res.message, res.data);
      setSendAmount('');
      setSendDest('');
    } catch (err) {
      showResult('error', err.response?.data?.message || err.message);
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="max-w-4xl mx-auto py-8 sm:py-12 px-4 sm:px-6 min-w-0">
      <div className="mb-8 sm:mb-10 text-center">
        <h1 className="text-2xl sm:text-3xl font-bold mb-3">Wallet Simulator</h1>
        <p className="text-gray-500">Test the REST API endpoints without WhatsApp</p>
      </div>

      {result.message && (
        <div className={`mb-8 p-4 rounded-lg flex items-start gap-3 border min-w-0 ${
          result.type === 'error' ? 'bg-red-50 border-red-200 text-red-800' : 'bg-green-50 border-green-200 text-green-800'
        }`}>
          {result.type === 'error' ? <AlertCircle className="shrink-0 mt-0.5" /> : <CheckCircle2 className="shrink-0 mt-0.5" />}
          <div className="min-w-0">
            <p className="font-semibold">{result.message}</p>
            {result.data && (
              <pre className="mt-2 max-w-full text-xs bg-white/60 p-3 rounded overflow-x-auto">
                {JSON.stringify(result.data, null, 2)}
              </pre>
            )}
          </div>
        </div>
      )}

      <div className="bg-white p-4 sm:p-6 rounded-2xl shadow-sm border border-gray-100 mb-8">
        <label className="block text-sm font-medium text-gray-700 mb-2">Simulate Phone Number</label>
        <div className="flex flex-col sm:flex-row gap-4">
          <input
            type="text"
            placeholder="+1234567890"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="w-full min-w-0 flex-grow px-4 py-3 rounded-lg border border-gray-200 focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all"
          />
          <button
            onClick={handleCreate}
            disabled={loading !== null}
            className="w-full sm:w-auto sm:shrink-0 flex items-center justify-center gap-2 bg-primary hover:bg-accent text-white px-6 py-3 rounded-lg font-medium transition-colors disabled:opacity-70"
          >
            {loading === 'create' ? <Loader size={20} className="text-white" /> : <Wallet size={20} />}
            Create Wallet
          </button>
          <button
            onClick={handleBalance}
            disabled={loading !== null}
            className="w-full sm:w-auto sm:shrink-0 flex items-center justify-center gap-2 bg-secondary text-primary hover:bg-teal-100 px-6 py-3 rounded-lg font-medium transition-colors disabled:opacity-70"
          >
            {loading === 'balance' ? <Loader size={20} /> : <Search size={20} />}
            Check Balance
          </button>
        </div>
      </div>

      <div className="bg-white p-4 sm:p-6 rounded-2xl shadow-sm border border-gray-100">
        <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
          <Send className="text-primary" size={20} />
          Send XLM
        </h3>
        <form onSubmit={handleSend} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Amount (XLM)</label>
              <input
                type="number"
                step="0.0000001"
                placeholder="5.0"
                value={sendAmount}
                onChange={(e) => setSendAmount(e.target.value)}
                className="w-full px-4 py-3 rounded-lg border border-gray-200 focus:ring-2 focus:ring-primary outline-none transition-all"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Destination Address</label>
              <input
                type="text"
                placeholder="G..."
                value={sendDest}
                onChange={(e) => setSendDest(e.target.value)}
                className="w-full px-4 py-3 rounded-lg border border-gray-200 focus:ring-2 focus:ring-primary outline-none transition-all font-mono text-sm"
              />
            </div>
          </div>
          <div className="pt-2">
            <button
              type="submit"
              disabled={loading !== null}
              className="w-full flex items-center justify-center gap-2 bg-dark hover:bg-gray-800 text-white px-6 py-3 rounded-lg font-medium transition-colors disabled:opacity-70"
            >
              {loading === 'send' ? <Loader size={20} className="text-white" /> : 'Submit Transaction'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
