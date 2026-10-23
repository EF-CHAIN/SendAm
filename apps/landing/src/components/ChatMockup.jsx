import { useState, useEffect } from 'react';
import { Check, CheckCheck, Clock, Mic } from 'lucide-react';
import PhoneFrame from './PhoneFrame.jsx';
import ResponsivePicture from './ResponsivePicture.jsx';
import { HERO_WALLPAPER } from '@/lib/heroImages.js';

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
    text: 'Payment sent.\nReceipt: SDA-9284\nYou can also say: balance, history.',
    time: '9:42',
  },
  { from: 'user', text: 'voice note: what is my balance', time: '9:43', voice: true },
  {
    from: 'bot',
    text: 'Your SendAm balance:\nstellar: 340 XLM',
    time: '9:43',
  },
];

// `priority` marks the wallpaper as above-the-fold (eager + high fetch priority).
export default function ChatMockup({ priority = false }) {
const TICK_TIMELINE = [
  { delay: 500, index: 0, status: 'sent' },
  { delay: 1100, index: 0, status: 'delivered' },
  { delay: 1700, index: 0, status: 'read' },
  { delay: 2300, index: 2, status: 'sent' },
  { delay: 2900, index: 2, status: 'delivered' },
  { delay: 3500, index: 2, status: 'read' },
  { delay: 4100, index: 4, status: 'sent' },
  { delay: 4700, index: 4, status: 'delivered' },
  { delay: 5300, index: 4, status: 'read' },
];

const LOOP_DELAY = 10000;

export function ReceiptTick({ status = 'read' }) {
  const getIcon = () => {
    switch (status) {
      case 'sending':
        return (
          <Clock
            size={12}
            className="text-slate-400 transition-opacity duration-300 motion-reduce:transition-none"
            aria-hidden="true"
          />
        );
      case 'sent':
        return (
          <Check
            size={12}
            className="text-slate-400 transition-all duration-300 motion-reduce:transition-none"
            aria-hidden="true"
          />
        );
      case 'delivered':
        return (
          <CheckCheck
            size={12}
            className="text-slate-400 transition-all duration-300 motion-reduce:transition-none"
            aria-hidden="true"
          />
        );
      case 'read':
      default:
        return (
          <CheckCheck
            size={12}
            className="text-sky-500 transition-colors duration-300 motion-reduce:transition-none"
            aria-hidden="true"
          />
        );
    }
  };

  const statusLabel = {
    sending: 'Sending',
    sent: 'Sent',
    delivered: 'Delivered',
    read: 'Read and settled',
  }[status] || 'Read and settled';

  return (
    <span
      className="inline-flex items-center transition-all duration-300 ease-in-out motion-reduce:transition-none"
      title={statusLabel}
      data-testid="receipt-tick"
      data-state={status}
    >
      <span className="sr-only">{statusLabel}</span>
      {getIcon()}
    </span>
  );
}

export default function ChatMockup({
  autoAnimate = typeof import.meta !== 'undefined' && import.meta.env?.MODE !== 'test',
  loop = true,
} = {}) {
  const isReducedMotion =
    typeof window !== 'undefined' &&
    window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const shouldAnimate = autoAnimate && !isReducedMotion;

  const [tickStates, setTickStates] = useState(() =>
    shouldAnimate
      ? { 0: 'sending', 2: 'sending', 4: 'sending' }
      : { 0: 'read', 2: 'read', 4: 'read' }
  );

  useEffect(() => {
    if (!shouldAnimate) {
      return;
    }

    let timeouts = [];

    const startAnimationSequence = () => {
      TICK_TIMELINE.forEach(({ delay, index, status }) => {
        const timer = setTimeout(() => {
          setTickStates((prev) => ({ ...prev, [index]: status }));
        }, delay);
        timeouts.push(timer);
      });

      if (loop) {
        const loopTimer = setTimeout(() => {
          setTickStates({
            0: 'sending',
            2: 'sending',
            4: 'sending',
          });
          startAnimationSequence();
        }, LOOP_DELAY);
        timeouts.push(loopTimer);
      }
    };

    startAnimationSequence();

    return () => {
      timeouts.forEach(clearTimeout);
    };
  }, [shouldAnimate, loop]);

  return (
    <PhoneFrame statusBarClassName="bg-whatsapp-dark text-white">
      <div className="relative isolate flex h-full flex-col bg-[#ece5dd]">
        <ResponsivePicture
          {...HERO_WALLPAPER}
          priority={priority}
          className="absolute inset-0 -z-10 h-full w-full object-cover object-center"
        />
        <div className="flex items-center gap-3 bg-whatsapp-dark px-4 pb-3 pt-10 text-white">
          <div className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-full font-bold">
            <img
              src="/logo-sent.svg"
              alt=""
              width="36"
              height="36"
              fetchPriority="high"
              loading="eager"
              className="h-full w-full object-cover"
            />
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
                    {isUser && (
                      <ReceiptTick status={tickStates[i] || 'read'} />
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
