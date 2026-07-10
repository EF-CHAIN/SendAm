import { Check, CheckCheck, Mic } from 'lucide-react';
import PhoneFrame from './PhoneFrame.jsx';

const messages = [
  { from: 'user', text: 'Send 25000 NGN to Ada', time: '9:41' },
  {
    from: 'bot',
    text: 'Quote ready\nAda receives USDC value\nFee: 1%\nReply with your PIN to confirm.',
    time: '9:41',
  },
  { from: 'user', text: '****', time: '9:42' },
  {
    from: 'bot',
    text: 'Payment sent.\nReceipt: SDA-9284\nYou can also say: escrow, cash-out, balance, history.',
    time: '9:42',
  },
  { from: 'user', text: 'voice note: cash out near Ikeja', time: '9:43', voice: true },
  {
    from: 'bot',
    text: 'I found nearby cash-out agents. Share location to continue.',
    time: '9:43',
  },
];

export default function ChatMockup() {
  return (
    <PhoneFrame statusBarClassName="bg-whatsapp-dark text-white">
      <div className="flex h-full flex-col bg-[#ece5dd] bg-[url('/whatsapp-bg.png')] bg-cover bg-center">
        <div className="flex items-center gap-3 bg-whatsapp-dark px-4 pb-3 pt-10 text-white">
          <div className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-full font-bold">
            <img src="/logo-sent.svg" alt="" className="h-full w-full object-cover" />
          </div>
          <div className="leading-tight">
            <p className="text-sm font-semibold">SendAm</p>
            <p className="text-[11px] text-white/70">online</p>
          </div>
        </div>

        <div className="flex-1 space-y-2 overflow-hidden px-3 py-4">
          {messages.map((m, i) => {
            const isUser = m.from === 'user';
            return (
              <div
                key={i}
                className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[82%] whitespace-pre-line rounded-2xl px-3 py-2 text-[12px] leading-snug shadow-sm ${
                    isUser
                      ? 'rounded-br-sm bg-[#d9fdd3] text-slate-800'
                      : 'rounded-bl-sm bg-white text-slate-800'
                  }`}
                >
                  {m.voice && <Mic size={14} className="mr-1 inline text-whatsapp" aria-hidden="true" />}
                  {m.text}
                  <span className="ml-2 inline-flex items-center gap-0.5 align-bottom text-[10px] text-slate-400">
                    {m.time}
                    {isUser ? (
                      <CheckCheck size={12} className="text-sky-500" />
                    ) : (
                      <Check size={12} />
                    )}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex items-center gap-2 px-3 pb-7 pt-2">
          <div className="flex-1 rounded-full bg-slate-100 px-4 py-2 text-[12px] text-slate-400">
            Message or voice note
          </div>
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-whatsapp text-white">
            <Mic size={16} aria-hidden="true" />
          </div>
        </div>
      </div>
    </PhoneFrame>
  );
}
