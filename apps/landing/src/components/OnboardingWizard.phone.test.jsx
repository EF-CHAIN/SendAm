import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import OnboardingWizard from './OnboardingWizard.jsx';
import { COUNTRY_PRESETS, formatE164 } from '@/lib/phoneFormat.js';

/* ─── unit: formatE164 ────────────────────────────────────────────────── */
describe('formatE164 helper', () => {
  const NG = COUNTRY_PRESETS.find((c) => c.code === 'NG');
  const GH = COUNTRY_PRESETS.find((c) => c.code === 'GH');
  const GB = COUNTRY_PRESETS.find((c) => c.code === 'GB');
  const US = COUNTRY_PRESETS.find((c) => c.code === 'US');

  it('returns dial code only when input is empty', () => {
    expect(formatE164('', NG)).toBe('+234');
  });

  it('formats Nigerian number with spaces: XXX XXX XXXX', () => {
    expect(formatE164('8012345678', NG)).toBe('+234 801 234 5678');
  });

  it('strips non-digit characters from input before formatting', () => {
    expect(formatE164('(801) 234-5678', NG)).toBe('+234 801 234 5678');
  });

  it('formats Ghanaian number with spaces: XX XXX XXXX', () => {
    expect(formatE164('241987654', GH)).toBe('+233 24 198 7654');
  });

  it('formats UK number with spaces: XXXX XXX XXXX', () => {
    expect(formatE164('7911123456', GB)).toBe('+44 7911 123 456');
  });

  it('formats US number with spaces: XXX XXX XXXX', () => {
    expect(formatE164('2025550123', US)).toBe('+1 202 555 0123');
  });
});

/* ─── unit: COUNTRY_PRESETS ───────────────────────────────────────────── */
describe('COUNTRY_PRESETS', () => {
  it('includes the 5 required countries', () => {
    const codes = COUNTRY_PRESETS.map((c) => c.code);
    expect(codes).toContain('NG');
    expect(codes).toContain('GH');
    expect(codes).toContain('KE');
    expect(codes).toContain('GB');
    expect(codes).toContain('US');
  });

  it('each preset has a flag, dialCode, regex, and format function', () => {
    for (const preset of COUNTRY_PRESETS) {
      expect(preset.flag).toBeTruthy();
      expect(preset.dialCode).toMatch(/^\+\d+$/);
      expect(preset.regex).toBeInstanceOf(RegExp);
      expect(typeof preset.format).toBe('function');
    }
  });

  it('regex validates correctly formatted E.164 numbers', () => {
    const cases = [
      ['NG', '+2348012345678'],
      ['GH', '+233241987654'],
      ['KE', '+254712345678'],
      ['GB', '+447911123456'],
      ['US', '+12025550123'],
    ];
    for (const [code, number] of cases) {
      const preset = COUNTRY_PRESETS.find((c) => c.code === code);
      expect(preset.regex.test(number)).toBe(true);
    }
  });
});

/* ─── integration: CountryPhonePicker in OnboardingWizard ─────────────── */
describe('CountryPhonePicker in OnboardingWizard', () => {
  beforeEach(() => {
    // localStorage not available in jsdom - ensure it is mocked
    vi.spyOn(Storage.prototype, 'getItem').mockReturnValue(null);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {});
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {});
  });

  it('renders the country picker button with Nigeria selected by default', () => {
    render(<OnboardingWizard />);
    const pickerBtn = screen.getByRole('button', {
      name: /Selected country: Nigeria/i,
    });
    expect(pickerBtn).toBeInTheDocument();
    expect(pickerBtn).toHaveAttribute('aria-expanded', 'false');
  });

  it('renders phone number input with aria-label and default Nigeria placeholder', () => {
    render(<OnboardingWizard />);
    const phoneInput = screen.getByRole('textbox', { name: /WhatsApp Phone Number/i });
    expect(phoneInput).toBeInTheDocument();
    expect(phoneInput).toHaveAttribute('placeholder', '+234 801 234 5678');
  });

  it('opens country listbox when picker button is clicked', async () => {
    const user = userEvent.setup();
    render(<OnboardingWizard />);
    const pickerBtn = screen.getByRole('button', { name: /Selected country: Nigeria/i });
    await user.click(pickerBtn);

    expect(pickerBtn).toHaveAttribute('aria-expanded', 'true');
    const listbox = screen.getByRole('listbox', { name: /Select country/i });
    expect(listbox).toBeInTheDocument();

    // All 5 countries should appear
    expect(within(listbox).getByText('Nigeria')).toBeInTheDocument();
    expect(within(listbox).getByText('Ghana')).toBeInTheDocument();
    expect(within(listbox).getByText('Kenya')).toBeInTheDocument();
    expect(within(listbox).getByText('United Kingdom')).toBeInTheDocument();
    expect(within(listbox).getByText('United States')).toBeInTheDocument();
  });

  it('switches to Ghana and updates dial code when Ghana is selected', async () => {
    const user = userEvent.setup();
    render(<OnboardingWizard />);

    // Open picker
    await user.click(screen.getByRole('button', { name: /Selected country: Nigeria/i }));

    // Select Ghana
    const listbox = screen.getByRole('listbox', { name: /Select country/i });
    await user.click(within(listbox).getByText('Ghana'));

    // Picker button should now reflect Ghana
    expect(
      screen.getByRole('button', { name: /Selected country: Ghana/i })
    ).toBeInTheDocument();

    // Placeholder should update to Ghana format
    const phoneInput = screen.getByRole('textbox', { name: /WhatsApp Phone Number/i });
    expect(phoneInput).toHaveAttribute('placeholder', '+233 24 198 7654');
  });

  it('auto-formats digits typed in the phone input with spaces', async () => {
    const user = userEvent.setup();
    render(<OnboardingWizard />);

    const phoneInput = screen.getByRole('textbox', { name: /WhatsApp Phone Number/i });
    // Clear field and type raw digits
    await user.clear(phoneInput);
    await user.type(phoneInput, '8012345678');

    // Should be formatted as +234 801 234 5678
    expect(phoneInput.value).toBe('+234 801 234 5678');
  });

  it('shows valid E.164 hint when phone number is a complete valid number', async () => {
    const user = userEvent.setup();
    render(<OnboardingWizard />);

    const phoneInput = screen.getByRole('textbox', { name: /WhatsApp Phone Number/i });
    await user.clear(phoneInput);
    await user.type(phoneInput, '8012345678');

    // Validation hint should appear
    expect(screen.getByText(/Valid E\.164 format/i)).toBeInTheDocument();
  });

  it('closes dropdown when clicking outside', async () => {
    const user = userEvent.setup();
    const { container } = render(<OnboardingWizard />);

    await user.click(screen.getByRole('button', { name: /Selected country: Nigeria/i }));
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    // Click outside
    await user.click(container.firstChild);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});
