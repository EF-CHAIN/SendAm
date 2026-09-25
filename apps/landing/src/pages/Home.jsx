import Hero from '@/components/Hero.jsx';
import CurrencyCalculator from '@/components/CurrencyCalculator.jsx';
import Features from '@/components/Features.jsx';
import HowItWorks from '@/components/HowItWorks.jsx';
import Faq from '@/components/Faq.jsx';
import CtaBand from '@/components/CtaBand.jsx';

export default function Home() {
  return (
    <>
      <Hero />
      <CurrencyCalculator />
      <Features />
      <HowItWorks />
      <Faq />
      <CtaBand />
    </>
  );
}
