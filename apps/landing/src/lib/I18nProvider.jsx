import { useCallback, useEffect, useMemo, useState } from 'react';
import { DICTIONARY, I18nContext, STORAGE_KEY, storedLanguage } from './i18n.js';

export default function I18nProvider({ children }) {
  const [lang, setLangState] = useState(storedLanguage);

  const setLang = useCallback((code) => {
    if (!DICTIONARY[code]) return;
    setLangState(code);
    try {
      window.localStorage.setItem(STORAGE_KEY, code);
    } catch {
      // Private windows without storage still switch for the session.
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const value = useMemo(() => {
    const t = (key) => DICTIONARY[lang]?.[key] ?? DICTIONARY.en[key] ?? key;
    return { lang, setLang, t };
  }, [lang, setLang]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
