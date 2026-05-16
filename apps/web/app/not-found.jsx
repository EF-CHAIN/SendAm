import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="min-h-[70vh] flex flex-col items-center justify-center text-center px-4">
      <h2 className="text-4xl font-bold text-dark mb-4">404 - Page Not Found</h2>
      <p className="text-gray-500 mb-8 max-w-md">
        The page you are looking for doesn't exist or has been moved.
      </p>
      <Link href="/" className="bg-primary hover:bg-accent text-white px-6 py-3 rounded-lg font-medium transition-colors">
        Return Home
      </Link>
    </div>
  );
}
