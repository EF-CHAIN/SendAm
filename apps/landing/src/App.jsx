import { Routes, Route } from 'react-router-dom';
import Navbar from './components/Navbar.jsx';
import Footer from './components/Footer.jsx';
import Home from './pages/Home.jsx';
import OnboardingStatus from './pages/OnboardingStatus.jsx';
import NotFound from './pages/NotFound.jsx';

export default function App() {
  return (
    <div className="flex flex-col min-h-screen bg-gray-50 text-dark font-sans">
      <Navbar />
      <main className="flex-grow w-full min-w-0">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/onboarding" element={<OnboardingStatus />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
      <Footer />
    </div>
  );
}
