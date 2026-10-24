import { describe, it, expect } from 'vitest';
import { WHATSAPP_THEMES } from '../theme';

function hexToRgb(hex) {
  const cleanHex = hex.replace('#', '');
  const bigint = parseInt(cleanHex, 16);
  return {
    r: (bigint >> 16) & 255,
    g: (bigint >> 8) & 255,
    b: bigint & 255,
  };
}

function relativeLuminance({ r, g, b }) {
  const [sR, sG, sB] = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * sR + 0.7152 * sG + 0.0722 * sB;
}

function contrastRatio(hex1, hex2) {
  const lum1 = relativeLuminance(hexToRgb(hex1));
  const lum2 = relativeLuminance(hexToRgb(hex2));
  const brightest = Math.max(lum1, lum2);
  const darkest = Math.min(lum1, lum2);
  return (brightest + 0.05) / (darkest + 0.05);
}

describe('WhatsApp Web Theme Tokens', () => {
  it('defines dark theme with authentic WhatsApp Web hex codes', () => {
    const dark = WHATSAPP_THEMES.dark;
    expect(dark).toBeDefined();
    expect(dark.background).toBe('#111b21');
    expect(dark.chatBackground).toBe('#111b21');
    expect(dark.outboundBubble).toBe('#005c4b');
    expect(dark.inboundBubble).toBe('#202c33');
    expect(dark.outboundText).toBe('#e9edef');
    expect(dark.inboundText).toBe('#e9edef');
    expect(dark.headerBg).toBe('#202c33');
    expect(dark.headerText).toBe('#e9edef');
    expect(dark.inputBarBg).toBe('#202c33');
    expect(dark.inputBg).toBe('#2a3942');
    expect(dark.inputText).toBe('#d1d7db');
    expect(dark.inputPlaceholder).toBe('#8696a0');
  });

  it('defines light theme with WhatsApp authentic tokens', () => {
    const light = WHATSAPP_THEMES.light;
    expect(light).toBeDefined();
    expect(light.background).toBe('#efeae2');
    expect(light.chatBackground).toBe('#efeae2');
    expect(light.outboundBubble).toBe('#d9fdd3');
    expect(light.inboundBubble).toBe('#ffffff');
    expect(light.headerBg).toBe('#f0f2f5');
    expect(light.inputBarBg).toBe('#f0f2f5');
  });

  it('satisfies WCAG AA contrast standards in dark mode', () => {
    const dark = WHATSAPP_THEMES.dark;
    // Outbound bubble contrast (text vs bubble)
    const outboundContrast = contrastRatio(dark.outboundText, dark.outboundBubble);
    expect(outboundContrast).toBeGreaterThanOrEqual(4.5);

    // Inbound bubble contrast (text vs bubble)
    const inboundContrast = contrastRatio(dark.inboundText, dark.inboundBubble);
    expect(inboundContrast).toBeGreaterThanOrEqual(4.5);

    // Header contrast (text vs header background)
    const headerContrast = contrastRatio(dark.headerText, dark.headerBg);
    expect(headerContrast).toBeGreaterThanOrEqual(4.5);

    // Input text contrast (text vs input background)
    const inputContrast = contrastRatio(dark.inputText, dark.inputBg);
    expect(inputContrast).toBeGreaterThanOrEqual(4.5);
  });
});
