import { Platform } from 'react-native';
import * as Clipboard from 'expo-clipboard';

export async function copyMessageText(text) {
  if (Platform.OS === 'web') {
    // Expo's legacy web fallback can report success when execCommand returns
    // false. Only acknowledge a fulfilled modern clipboard write on the web.
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
      throw new Error('Clipboard unavailable');
    }
    await navigator.clipboard.writeText(text);
    return;
  }
  if (!(await Clipboard.setStringAsync(text))) {
    throw new Error('Clipboard unavailable');
  }
}
