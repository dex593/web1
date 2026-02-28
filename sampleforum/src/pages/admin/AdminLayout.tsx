import { useState, memo } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  FileText,
  MessageSquare,
  FolderOpen,
  Shield,
  Menu,
  X,
  Bell,
  LogOut
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const navItems = [
  { label: 'Tổng quan', icon: LayoutDashboard, path: '/admin' },
  { label: 'Bài viết', icon: FileText, path: '/admin/posts' },
  { label: 'Bình luận', icon: MessageSquare, path: '/admin/comments' },
  { label: 'Danh mục', icon: FolderOpen, path: '/admin/categories' },
];

const AdminLayout = () => {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const location = useLocation();

  return (
    <div className="flex h-screen bg-background overflow-hidden">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div className="fixed inset-0 bg-black/50 z-40 lg:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      {/* Sidebar */}
      <aside className={cn(
        "fixed lg:static z-50 h-full flex flex-col border-r border-border bg-card transition-transform duration-200",
        sidebarOpen ? "translate-x-0 w-60" : "-translate-x-full lg:translate-x-0 lg:w-14 w-60"
      )}>
        <div className="flex items-center gap-2 p-4 border-b border-border">
          <Shield className="h-5 w-5 text-primary shrink-0" />
          {(sidebarOpen) && <span className="font-semibold text-sm">Quản trị viên</span>}
        </div>
        <nav className="flex-1 overflow-y-auto py-2">
          {navItems.map(item => {
            const active = location.pathname === item.path || (item.path !== '/admin' && location.pathname.startsWith(item.path));
            return (
              <Link
                key={item.path}
                to={item.path}
                className={cn(
                  "flex items-center gap-3 px-4 py-2.5 mx-2 rounded-md text-sm transition-colors",
                  active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground"
                )}
                onClick={() => window.innerWidth < 1024 && setSidebarOpen(false)}
                >
                  <item.icon className="h-4 w-4 shrink-0" />
                  {sidebarOpen && <span className="truncate">{item.label}</span>}
                </Link>
              );
            })}
        </nav>
        <div className="p-3 border-t border-border">
          <Link to="/" className={cn(
            "flex items-center gap-3 px-2 py-2 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          )}>
            <LogOut className="h-4 w-4 shrink-0" />
            {sidebarOpen && <span>Về trang chủ</span>}
          </Link>
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Topbar */}
        <header className="h-14 border-b border-border bg-card flex items-center justify-between px-4 shrink-0">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => setSidebarOpen(!sidebarOpen)} className="h-8 w-8">
              {sidebarOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
            </Button>
            <h1 className="text-sm font-medium hidden sm:block">Bảng điều khiển</h1>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" className="h-8 w-8 relative">
              <Bell className="h-4 w-4" />
              <span className="absolute top-1 right-1 w-2 h-2 bg-primary rounded-full" />
            </Button>
            <div className="flex items-center gap-2 pl-2 border-l border-border">
              <div className="w-7 h-7 rounded-full bg-primary/20 flex items-center justify-center">
                <Shield className="h-3.5 w-3.5 text-primary" />
              </div>
              <span className="text-xs font-medium hidden sm:block">Admin</span>
            </div>
          </div>
        </header>

        {/* Content */}
        <main className="flex-1 overflow-y-auto p-4 md:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
};

export default memo(AdminLayout);
