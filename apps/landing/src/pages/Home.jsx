import { lazy } from 'react';
import Hero from '@/components/Hero.jsx';
import LazySection from '@/components/LazySection.jsx';
import { loadCorridorGlobe, loadCurrencyCalculator } from '@/lib/lazySections.js';
import Features from '@/components/Features.jsx';
import OnboardingWizard from '@/components/OnboardingWizard.jsx';
import HowItWorks from '@/components/HowItWorks.jsx';
import Faq from '@/components/Faq.jsx';
import CtaBand from '@/components/CtaBand.jsx';

// Heavy, below-the-fold sections are split into their own chunks and only
// fetched when the user scrolls near them (see LazySection).
const CurrencyCalculator = lazy(loadCurrencyCalculator);
const CorridorGlobe = lazy(loadCorridorGlobe);

export default function Home() {
  return (
    <>
      <Hero />
      <LazySection id="calculator" label="Currency calculator" minHeight={720}>
        <CurrencyCalculator />
      </LazySection>
      <Features />
      <LazySection id="geo-corridors" label="Payment corridors" minHeight={860}>
        <CorridorGlobe />
      </LazySection>
      <OnboardingWizard />
      <HowItWorks />
      <Faq />
      <CtaBand />
    </>
  );
}
