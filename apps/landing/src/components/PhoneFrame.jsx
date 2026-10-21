import { useEffect, useId, useState } from 'react';
import { BEZEL_PRESETS } from './phoneFramePresets.js';

// Titanium iPhone-Pro-style case, ported from the tella project to plain JSX
// + Tailwind (no next/image or custom design tokens). The status-bar colour is
// configurable so the chat header can blend seamlessly into the top of the
// display.
//
// The outer wrapper establishes an inline-size container and the frame chrome
// is sized in container-query units (`cqw`), so the bezel, notch, buttons, and
// radii scale proportionally at any rendered width instead of snapping at a
// fixed pixel size.
export default function PhoneFrame({
  children,
  statusBarClassName = 'bg-[#1F2C34] text-white',
  className = '',
  bezel = 'titanium',
  dynamicIsland = true,
  reflection = true,
}) {
  const [time, setTime] = useState('--:--');
  const instanceId = useId().replace(/[^a-zA-Z0-9]/g, '');
  const glassReflectionId = `phone-glass-reflection-${instanceId}`;
  const glassEdgeId = `phone-glass-edge-${instanceId}`;

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

  const preset = BEZEL_PRESETS[bezel] ?? BEZEL_PRESETS.titanium;

  const buttonClassName =
    'absolute w-[1cqw] shadow-[inset_0_1px_0_rgba(255,255,255,0.3)]';

  return (
    <div
      data-bezel={bezel}
      data-dynamic-island={dynamicIsland ? 'true' : 'false'}
      className="relative mx-auto w-full max-w-[300px]"
      style={{ containerType: 'inline-size' }}
    >
      <div
        className={
          'relative aspect-[75/150] w-full rounded-[17cqw] p-[1cqw] ' + className
        }
        style={{
          background: preset.frame,
          boxShadow:
            `inset 0 0 0 0.5px ${preset.edge}, ` +
            `inset 0 1px 0 ${preset.edge}, ` +
            'inset 0 -1px 0 rgba(0,0,0,0.5), ' +
            '0 40px 80px -20px rgba(10,10,10,0.55), ' +
            '0 0 0 1px rgba(0,0,0,0.5), ' +
            `0 0 70px -10px ${preset.halo}`,
        }}
      >
        {/* Metallic side buttons in the Pro layout */}
        <div
          className={`${buttonClassName} -left-[1cqw] top-[26.7cqw] h-[9.3cqw] rounded-l-md`}
          style={{ background: preset.button }}
        />
        <div
          className={`${buttonClassName} -left-[1cqw] top-[37.3cqw] h-[16cqw] rounded-l-md`}
          style={{ background: preset.button }}
        />
        <div
          className={`${buttonClassName} -left-[1cqw] top-[58.7cqw] h-[16cqw] rounded-l-md`}
          style={{ background: preset.button }}
        />
        <div
          className={`${buttonClassName} -right-[1cqw] top-[42.7cqw] h-[26.7cqw] rounded-r-md`}
          style={{ background: preset.buttonAlt }}
        />
        <div
          className={`${buttonClassName} -right-[1cqw] top-[74.7cqw] h-[13.3cqw] rounded-r-md`}
          style={{ background: preset.buttonAlt }}
        />

        {/* Black bezel between frame and display */}
        <div
          className="relative h-full w-full rounded-[16cqw] p-[2cqw] shadow-[inset_0_0_0_1px_rgba(0,0,0,0.8)]"
          style={{ background: preset.bezel }}
        >
          {/* Display */}
          <div className="relative h-full w-full overflow-hidden rounded-[13.3cqw] bg-[#ece5dd]">
            {dynamicIsland ? (
              /* Dynamic Island with camera lens */
              <div
                data-notch="island"
                className="pointer-events-none absolute left-1/2 top-[2.7cqw] z-30 flex h-[8cqw] w-[21.3cqw] -translate-x-1/2 items-center justify-end rounded-full bg-black pr-[3.3cqw] shadow-[inset_0_0_1px_rgba(255,255,255,0.12)]"
              >
                <span className="block h-[2.4cqw] w-[2.4cqw] rounded-full bg-[#101012] ring-1 ring-[#26262b]" />
              </div>
            ) : (
              /* Classic speaker notch: housing + speaker grille + camera */
              <div
                data-notch="speaker"
                className="pointer-events-none absolute left-1/2 top-[2cqw] z-30 h-[6.7cqw] w-[42cqw] -translate-x-1/2 rounded-b-[3.3cqw] rounded-t-[1.3cqw] bg-black"
              >
                <span className="absolute left-1/2 top-1/2 h-[1cqw] w-[16cqw] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#26262b]" />
                <span className="absolute right-[4cqw] top-1/2 block h-[2.4cqw] w-[2.4cqw] -translate-y-1/2 rounded-full bg-[#101012] ring-1 ring-[#26262b]" />
              </div>
            )}

            {/* iOS status bar, time on the left, signal/wifi/battery on the right */}
            <div
              className={
                'pointer-events-none absolute inset-x-0 top-[2.7cqw] z-20 flex h-[8cqw] items-center justify-between px-[5.3cqw] text-[3.7cqw] font-semibold ' +
                statusBarClassName
              }
            >
              <span>{time}</span>
              <div className="flex items-center gap-[2.3cqw]">
                <img src="/icons/Cellular.svg" alt="" aria-hidden="true" className="h-[4cqw] w-auto" />
                <img src="/icons/Wifi.svg" alt="" aria-hidden="true" className="h-[4cqw] w-auto" />
                <img src="/icons/Battery.svg" alt="" aria-hidden="true" className="h-[4cqw] w-auto" />
              </div>
            </div>

            {/* Screen content fills the whole display */}
            <div className="h-full">{children}</div>

            {/* Glass specular reflection, a diagonal highlight plus edge shading */}
            {reflection && (
              <svg
                className="pointer-events-none absolute inset-0 z-40 h-full w-full"
                viewBox="0 0 300 600"
                preserveAspectRatio="none"
                aria-hidden="true"
                focusable="false"
              >
                <defs>
                  <linearGradient id={glassReflectionId} x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0%" stopColor="#ffffff" stopOpacity="0.38" />
                    <stop offset="18%" stopColor="#ffffff" stopOpacity="0.14" />
                    <stop offset="38%" stopColor="#ffffff" stopOpacity="0" />
                  </linearGradient>
                  <linearGradient id={glassEdgeId} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#ffffff" stopOpacity="0.22" />
                    <stop offset="14%" stopColor="#ffffff" stopOpacity="0" />
                    <stop offset="100%" stopColor="#000000" stopOpacity="0.16" />
                  </linearGradient>
                </defs>
                <rect width="300" height="600" fill={`url(#${glassReflectionId})`} />
                <rect width="300" height="600" fill={`url(#${glassEdgeId})`} />
              </svg>
            )}

            {/* iOS home indicator */}
            <div className="pointer-events-none absolute inset-x-0 bottom-[2cqw] z-20 flex items-center justify-center">
              <span className="block h-[1cqw] w-[26.7cqw] rounded-full bg-white" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
