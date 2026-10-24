import { createContext, useContext, useState } from 'react';

/**
 * Lightweight client-side i18n: a dictionary plus a `t(key)` lookup, shared
 * through context by <I18nProvider> (see I18nProvider.jsx). No network round
 * trips and no reload — switching languages re-renders in place. Keys fall
 * back to English, then to the key itself, so a missing translation can never
 * blank out the UI.
 */

export const LANGUAGES = [
  { code: 'en', label: 'English', nativeLabel: 'English' },
  { code: 'fr', label: 'French', nativeLabel: 'Français' },
  { code: 'sw', label: 'Swahili', nativeLabel: 'Kiswahili' },
  { code: 'yo', label: 'Yoruba', nativeLabel: 'Yorùbá' },
];

export const STORAGE_KEY = 'sendam.lang';

export const DICTIONARY = {
  en: {
    'nav.features': 'Features',
    'nav.howItWorks': 'How it works',
    'nav.faq': 'FAQ',
    'nav.onboarding': 'Onboarding',
    'nav.openWhatsApp': 'Open WhatsApp',
    'nav.start': 'Start',
    'nav.menu': 'Menu',
    'nav.openMenu': 'Open menu',
    'nav.closeMenu': 'Close menu',
    'nav.siteNavigation': 'Site navigation',
    'nav.language': 'Language',
  },
  fr: {
    'nav.features': 'Fonctionnalités',
    'nav.howItWorks': 'Comment ça marche',
    'nav.faq': 'FAQ',
    'nav.onboarding': 'Inscription',
    'nav.openWhatsApp': 'Ouvrir WhatsApp',
    'nav.start': 'Démarrer',
    'nav.menu': 'Menu',
    'nav.openMenu': 'Ouvrir le menu',
    'nav.closeMenu': 'Fermer le menu',
    'nav.siteNavigation': 'Navigation du site',
    'nav.language': 'Langue',
  },
  sw: {
    'nav.features': 'Vipengele',
    'nav.howItWorks': 'Jinsi inavyofanya kazi',
    'nav.faq': 'Maswali',
    'nav.onboarding': 'Usajili',
    'nav.openWhatsApp': 'Fungua WhatsApp',
    'nav.start': 'Anza',
    'nav.menu': 'Menyu',
    'nav.openMenu': 'Fungua menyu',
    'nav.closeMenu': 'Funga menyu',
    'nav.siteNavigation': 'Urambazaji wa tovuti',
    'nav.language': 'Lugha',
  },
  yo: {
    'nav.features': 'Àwọn ẹ̀yà',
    'nav.howItWorks': 'Bí ó ṣe ń ṣiṣẹ́',
    'nav.faq': 'Àwọn ìbéèrè',
    'nav.onboarding': 'Ìforúkọsílẹ̀',
    'nav.openWhatsApp': 'Ṣí WhatsApp',
    'nav.start': 'Bẹ̀rẹ̀',
    'nav.menu': 'Àtòjọ',
    'nav.openMenu': 'Ṣí àtòjọ',
    'nav.closeMenu': 'Ti àtòjọ',
    'nav.siteNavigation': 'Ìtọ́sọ́nà ojú-òpó',
    'nav.language': 'Èdè',
  },
};

export function storedLanguage() {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return DICTIONARY[stored] ? stored : 'en';
  } catch {
    return 'en';
  }
}

export const I18nContext = createContext(null);

/** Works without a provider (tests, isolated renders) by falling back to English. */
export function useI18n() {
  const context = useContext(I18nContext);
  const [fallbackLang, setFallbackLang] = useState('en');
  if (context) return context;
  return {
    lang: fallbackLang,
    setLang: (code) => {
      if (DICTIONARY[code]) setFallbackLang(code);
    },
    t: (key) => DICTIONARY[fallbackLang]?.[key] ?? DICTIONARY.en[key] ?? key,
  };
}
