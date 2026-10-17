import { useEffect, useRef, useState } from 'react';
import { Check, CheckCheck, Mic, Pause, Play } from 'lucide-react';
import PhoneFrame from './PhoneFrame.jsx';

const VOICE_DURATION = 14;
const WAVEFORM_BARS = Array.from({ length: 36 }, (_, index) => (
  5 + ((index * 17 + index * index * 3) % 16)
));

function formatTime(seconds) {
  const totalSeconds = Math.floor(seconds);
  return `0:${String(totalSeconds).padStart(2, '0')}`;
}

function VoiceMessage({ transcript }) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const currentTimeRef = useRef(0);
  const progress = currentTime / VOICE_DURATION;

  useEffect(() => {
    if (!isPlaying) return undefined;
    const intervalId = window.setInterval(() => {
      const nextTime = Math.min(currentTimeRef.current + 0.25, VOICE_DURATION);
      currentTimeRef.current = nextTime;
      setCurrentTime(nextTime);
      if (nextTime >= VOICE_DURATION) setIsPlaying(false);
    }, 250);
    return () => window.clearInterval(intervalId);
  }, [isPlaying]);

  return (
    <div className="flex w-[230px] max-w-full items-center gap-2" aria-label="Voice message player">
      <button
        type="button"
        onClick={() => {
          if (currentTimeRef.current >= VOICE_DURATION) {
            currentTimeRef.current = 0;
            setCurrentTime(0);
          }
          setIsPlaying((playing) => !playing);
        }}
        aria-label={isPlaying ? 'Pause voice note' : 'Play voice note'}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-whatsapp text-white"
      >
        {isPlaying ? <Pause size={15} aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}
      </button>
      <div className="min-w-0 flex-1">
        <div className="relative h-8">
          <svg viewBox="0 0 360 32" preserveAspectRatio="none" className="h-full w-full" aria-hidden="true">
            {WAVEFORM_BARS.map((barHeight, index) => (
              <rect
                key={index}
                x={index * 10}
                y={(32 - barHeight) / 2}
                width="5"
                height={barHeight}
                rx="2.5"
                fill={index / WAVEFORM_BARS.length <= progress ? '#128c7e' : '#94a3b8'}
                className={isPlaying ? 'animate-pulse' : ''}
              />
            ))}
          </svg>
          <input
            type="range"
            min="0"
            max={VOICE_DURATION}
            step="0.25"
            value={currentTime}
            onChange={(event) => {
              const nextTime = Number(event.target.value);
              currentTimeRef.current = nextTime;
              setCurrentTime(nextTime);
            }}
            aria-label="Seek voice message"
            aria-valuetext={`${formatTime(currentTime)} of ${formatTime(VOICE_DURATION)}`}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          />
          <span
            className="pointer-events-none absolute top-1/2 h-2.5 w-2.5 -translate-y-1/2 rounded-full border border-white bg-whatsapp shadow"
            style={{ left: `calc(${progress * 100}% - 5px)` }}
            aria-hidden="true"
          />
        </div>
        <div className="flex justify-between text-[10px] leading-none text-slate-500">
          <span>{formatTime(currentTime)}</span>
          <span>{formatTime(VOICE_DURATION)}</span>
        </div>
      </div>
      <span className="sr-only">{transcript}</span>
    </div>
  );
}

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
                  {m.voice ? <VoiceMessage transcript={m.text} /> : m.text}
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
