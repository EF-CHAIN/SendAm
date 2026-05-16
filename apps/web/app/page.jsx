import Link from 'next/link';
import { MessageSquare, Wallet, SendHorizontal, Zap } from 'lucide-react';

export default function LandingPage() {
  const features = [
    { title: 'Create Wallet', desc: 'Instantly generate a secure Stellar wallet via WhatsApp.', icon: Wallet },
    { title: 'Check Balance', desc: 'Query your XLM balance anytime with a simple text message.', icon: MessageSquare },
    { title: 'Send XLM', desc: 'Transfer funds across the globe in seconds.', icon: SendHorizontal },
    { title: 'Lightning Fast', desc: 'Powered by the Stellar network for near-instant settlement.', icon: Zap },
  ];

  return (
    <div className="min-h-screen flex flex-col items-center justify-center py-20 px-4">
      <div className="text-center max-w-3xl mx-auto mb-16">
        <div className="inline-block bg-secondary text-primary font-medium px-4 py-1.5 rounded-full mb-6 border border-teal-100">
          Stellar Testnet MVP
        </div>
        <h1 className="text-5xl md:text-6xl font-extrabold text-dark tracking-tight mb-6 leading-tight">
          Crypto Payments via <span className="text-primary">WhatsApp</span>
        </h1>
        <p className="text-xl text-gray-500 mb-10 max-w-2xl mx-auto">
          SendAm connects the power of the Stellar network with the simplicity of WhatsApp. Create wallets and send XLM effortlessly.
        </p>
        
        <div className="flex flex-col sm:flex-row gap-4 justify-center">
          <Link href="/wallet-test" className="bg-primary hover:bg-accent text-white px-8 py-4 rounded-xl font-semibold shadow-lg shadow-teal-500/30 transition-all hover:-translate-y-0.5">
            Test Wallet Features
          </Link>
          <Link href="/admin/login" className="bg-white hover:bg-gray-50 text-dark border border-gray-200 px-8 py-4 rounded-xl font-semibold shadow-sm transition-all hover:-translate-y-0.5">
            Admin Dashboard
          </Link>
        </div>
      </div>

      <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6 max-w-6xl mx-auto w-full">
        {features.map((f, i) => {
          const Icon = f.icon;
          return (
            <div key={i} className="bg-white p-8 rounded-2xl border border-gray-100 shadow-sm hover:shadow-md transition-shadow">
              <div className="bg-secondary w-14 h-14 rounded-xl flex items-center justify-center mb-6 text-primary">
                <Icon size={28} />
              </div>
              <h3 className="text-xl font-bold mb-3">{f.title}</h3>
              <p className="text-gray-500 leading-relaxed">{f.desc}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
