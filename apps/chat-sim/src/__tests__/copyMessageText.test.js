import { Platform } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { copyMessageText } from '../copyMessageText';

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));
const originalOS = Platform.OS;
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
afterEach(() => {
  Platform.OS = originalOS;
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else delete navigator.clipboard;
  jest.clearAllMocks();
});
function webClipboard(value) {
  Platform.OS = 'web';
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value });
}
it('writes exact text directly with modern web clipboard', async () => {
  const writeText = jest.fn().mockResolvedValue(undefined);
  webClipboard({ writeText });
  await copyMessageText('  address\n你好 💸');
  expect(writeText).toHaveBeenCalledWith('  address\n你好 💸');
  expect(Clipboard.setStringAsync).not.toHaveBeenCalled();
});
it('rejects unavailable web clipboard instead of trusting Expo legacy fallback', async () => {
  webClipboard(undefined);
  Clipboard.setStringAsync.mockResolvedValue(true);
  await expect(copyMessageText('address')).rejects.toThrow('Clipboard unavailable');
  expect(Clipboard.setStringAsync).not.toHaveBeenCalled();
});
it('propagates denied web writes without a falsely successful fallback', async () => {
  webClipboard({ writeText: jest.fn().mockRejectedValue(new Error('Denied')) });
  Clipboard.setStringAsync.mockResolvedValue(true);
  await expect(copyMessageText('address')).rejects.toThrow('Denied');
  expect(Clipboard.setStringAsync).not.toHaveBeenCalled();
});
it.each(['ios', 'android'])('uses Expo clipboard on %s', async (os) => {
  Platform.OS = os;
  Clipboard.setStringAsync.mockResolvedValue(true);
  await copyMessageText('address');
  expect(Clipboard.setStringAsync).toHaveBeenCalledWith('address');
});
it('rejects a false native result', async () => {
  Platform.OS = 'ios';
  Clipboard.setStringAsync.mockResolvedValue(false);
  await expect(copyMessageText('address')).rejects.toThrow('Clipboard unavailable');
});
