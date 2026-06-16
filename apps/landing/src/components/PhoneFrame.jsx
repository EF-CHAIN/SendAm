import { useEffect, useState } from 'react';

// Titanium iPhone-Pro-style case, ported from the tella project to plain JSX
// + Tailwind (no next/image or custom design tokens). The status-bar colour is
// configurable so the chat header can blend seamlessly into the top of the
// display.
export default function PhoneFrame({
  children,
  statusBarClassName = 'bg-[#1F2C34] text-white',
  className = '',
}) {
  const [time, setTime] = useState('--:--');

  useEffect(() => {
    const updateTime = () => {
      setTime(
        new Date()
          .toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            hour12: true,
          })
          .toLowerCase()
      );
    };

    updateTime();
    const interval = setInterval(updateTime, 60_000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div
      className={
        'relative mx-auto aspect-[75/150] w-[300px] rounded-[3.2rem] p-[3px] ' +
        // Titanium brushed-metal gradient
        '[background:linear-gradient(135deg,#2e2e30_0%,#5d5d60_18%,#9c9c9f_38%,#cdcdd0_50%,#9c9c9f_62%,#5d5d60_82%,#2e2e30_100%)] ' +
        // Polished edge highlights + drop shadow + metallic aura halo
        'shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.35),inset_0_1px_0_rgba(255,255,255,0.5),inset_0_-1px_0_rgba(0,0,0,0.5),0_40px_80px_-20px_rgba(10,10,10,0.55),0_0_0_1px_rgba(0,0,0,0.5),0_0_70px_-10px_rgba(190,195,200,0.45)] ' +
        className
      }
    >
      {/* Metallic side buttons — Pro layout */}
      <div className="absolute -left-[3px] top-20 h-7 w-[3px] rounded-l-md [background:linear-gradient(90deg,#2e2e30_0%,#7a7a7d_60%,#3a3a3c_100%)] shadow-[inset_0_1px_0_rgba(255,255,255,0.3)]" />
      <div className="absolute -left-[3px] top-28 h-12 w-[3px] rounded-l-md [background:linear-gradient(90deg,#2e2e30_0%,#7a7a7d_60%,#3a3a3c_100%)] shadow-[inset_0_1px_0_rgba(255,255,255,0.3)]" />
      <div className="absolute -left-[3px] top-44 h-12 w-[3px] rounded-l-md [background:linear-gradient(90deg,#2e2e30_0%,#7a7a7d_60%,#3a3a3c_100%)] shadow-[inset_0_1px_0_rgba(255,255,255,0.3)]" />
      <div className="absolute -right-[3px] top-32 h-20 w-[3px] rounded-r-md [background:linear-gradient(270deg,#2e2e30_0%,#7a7a7d_60%,#3a3a3c_100%)] shadow-[inset_0_1px_0_rgba(255,255,255,0.3)]" />
      <div className="absolute -right-[3px] top-56 h-10 w-[3px] rounded-r-md [background:linear-gradient(270deg,#2e2e30_0%,#7a7a7d_60%,#3a3a3c_100%)] shadow-[inset_0_1px_0_rgba(255,255,255,0.3)]" />

      {/* Black bezel between titanium frame and display */}
      <div className="relative h-full w-full rounded-[3rem] bg-[#0a0a0a] p-[6px] shadow-[inset_0_0_0_1px_rgba(0,0,0,0.8)]">
        {/* Display */}
        <div className="relative h-full w-full overflow-hidden rounded-[2.5rem] bg-[#ece5dd]">
          {/* Dynamic Island */}
          <div className="pointer-events-none absolute left-1/2 top-2 z-30 h-6 w-16 -translate-x-1/2 rounded-full bg-[#0a0a0a]">
            <span className="absolute right-2.5 top-1/2 block h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-[#1c1c1e]" />
          </div>

          {/* iOS status bar — time left, signal/wifi/battery right */}
          <div
            className={
              'pointer-events-none absolute inset-x-0 top-2 z-20 flex h-6 items-center justify-between px-4 text-[11px] font-semibold ' +
              statusBarClassName
            }
          >
            <span>{time}</span>
            <div className="flex items-center gap-[7px]">
              <img src="/icons/Cellular.svg" alt="" aria-hidden="true" className="h-3 w-auto" />
              <img src="/icons/Wifi.svg" alt="" aria-hidden="true" className="h-3 w-auto" />
              <img src="/icons/Battery.svg" alt="" aria-hidden="true" className="h-3 w-auto" />
            </div>
          </div>

          {/* Screen content — fills the whole display */}
          <div className="h-full">{children}</div>

          {/* iOS home indicator */}
          <div className="pointer-events-none absolute inset-x-0 bottom-1.5 z-20 flex items-center justify-center">
            <span className="block h-[3px] w-20 rounded-full bg-white" />
          </div>
        </div>
      </div>
    </div>
  );
}
