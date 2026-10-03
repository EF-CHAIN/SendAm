import { lazy, Suspense } from 'react';
import { Routes, Route } from 'react-router-dom';
import ErrorBoundary from '@shared/ErrorBoundary.jsx';
import NetworkStatusBanner from '@shared/NetworkStatusBanner.jsx';
import Navbar from './components/Navbar.jsx';
import Footer from './components/Footer.jsx';
import PWABanner from './components/PWABanner.jsx';
import Home from './pages/Home.jsx';
import NotFound from './pages/NotFound.jsx';

const OnboardingStatus = lazy(() => import('./pages/OnboardingStatus.jsx'));

export default function App() {
  return (
    <ErrorBoundary variant="landing">
      <div className="flex flex-col min-h-screen bg-gray-50 text-dark font-sans">
        <NetworkStatusBanner />
        <Navbar />
        <main className="flex-grow w-full min-w-0">
          <Suspense fallback={null}>
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/onboarding" element={<OnboardingStatus />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
        </main>
        <Footer />
        <PWABanner />
      </div>
    </ErrorBoundary>
  );
}
