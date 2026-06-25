export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-base text-fg">
      {children}
    </div>
  );
}
