export default function Footer() {
  return (
    <footer className="bg-gray-50 border-t border-gray-100 py-8 mt-auto">
      <div className="container mx-auto px-4 text-center text-gray-500 text-sm">
        &copy; {new Date().getFullYear()} SendAm. All rights reserved.
      </div>
    </footer>
  );
}
