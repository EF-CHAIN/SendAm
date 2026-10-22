import zxcvbn from 'zxcvbn';

export const MIN_PASSWORD_LENGTH = 12;
export const STRONG_PASSWORD_SCORE = 4;

// zxcvbn's score 4 estimates at least 10^10 guesses. Scores 0 and 1 share
// the Weak segment so that the UI has four levels, without lowering the gate.
const RATINGS = ['Weak', 'Weak', 'Fair', 'Good', 'Strong'];

export function getPasswordStrength(password) {
  // Bound synchronous scoring work for pasted/password-manager values. Only
  // the estimate uses this prefix; validation and submission keep the full
  // password unchanged. Dictionaries and scoring run entirely in the browser.
  // Do not retain zxcvbn's result: it contains the password and matched tokens.
  const { score, feedback } = zxcvbn(password.slice(0, 100), ['sendam', 'admin']);
  const meetsLength = password.length >= MIN_PASSWORD_LENGTH;
  const isStrong = meetsLength && score === STRONG_PASSWORD_SCORE;
  // A high estimator score never overrides the existing minimum length.
  const level = password.length === 0 ? 0 : Math.min(Math.max(score, 1), meetsLength ? 4 : 3);

  return {
    level,
    label: RATINGS[level],
    meetsLength,
    isStrong,
    feedback: !password
      ? 'Use a long, unique passphrase or a mix of letters, numbers and symbols.'
      : !meetsLength
        ? 'Password must be at least 12 characters.'
        : isStrong
          ? 'Strong estimate. Use this password only for SendAm.'
          : [feedback.warning, ...feedback.suggestions].filter(Boolean).join(' ') ||
            'Add another uncommon word or more unpredictable characters to reach Strong.',
  };
}
