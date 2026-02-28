import { memo } from 'react';
import { User } from '@/types/forum';
import { Shield, ShieldCheck } from 'lucide-react';

interface RoleBadgeProps {
  role?: User['role'];
}

export const RoleBadge = memo(function RoleBadge({ role }: RoleBadgeProps) {
  if (!role || role === 'member') return null;

  if (role === 'admin') {
    return (
      <span className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-semibold bg-primary/15 text-primary">
        <Shield className="h-2.5 w-2.5" />
        Admin
      </span>
    );
  }

  if (role === 'moderator') {
    return (
      <span className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-semibold bg-blue-500/15 text-blue-400">
        <ShieldCheck className="h-2.5 w-2.5" />
        Mod
      </span>
    );
  }

  return null;
});

interface UserInfoProps {
  user: User;
  size?: 'sm' | 'md';
  timestamp?: string;
  showUsername?: boolean;
}

export const UserInfo = memo(function UserInfo({ user, size = 'md', timestamp, showUsername = false }: UserInfoProps) {
  const avatarSize = size === 'sm' ? 'w-7 h-7' : 'w-9 h-9';
  const displayName = user.displayName || user.username;
  const nameStyle = user.userColor ? { color: user.userColor } : undefined;
  const profileUrl = (user.profileUrl || '').trim();
  const visibleBadges = Array.isArray(user.badges) ? user.badges : [];
  const displayBadges = visibleBadges.slice(0, 1);
  const hasAdminBadge = displayBadges.some((badge) => String(badge && badge.code ? badge.code : '').trim().toLowerCase() === 'admin');
  const hasModBadge = displayBadges.some((badge) => {
    const code = String(badge && badge.code ? badge.code : '').trim().toLowerCase();
    return code === 'mod' || code === 'moderator';
  });
  const shouldShowRoleBadge =
    user.role === 'admin' ? !hasAdminBadge : user.role === 'moderator' ? !hasModBadge : false;
  const NameNode = (
    <span
      className={`font-semibold hover:underline cursor-pointer truncate max-w-[160px] ${size === 'sm' ? 'text-xs' : 'text-sm'}`}
      style={nameStyle}
    >
      {displayName}
    </span>
  );

  return (
    <div className="flex items-center gap-2 min-w-0">
      {profileUrl ? (
        <a href={profileUrl} className="shrink-0">
          <img
            src={user.avatar}
            alt={user.displayName || user.username}
            className={`${avatarSize} rounded-full bg-accent hover:opacity-80 transition-opacity`}
            onError={(event) => {
              event.currentTarget.onerror = null;
              event.currentTarget.src = '/logobfang.svg';
            }}
          />
        </a>
      ) : (
        <img
          src={user.avatar}
          alt={user.displayName || user.username}
          className={`${avatarSize} rounded-full shrink-0 bg-accent`}
          onError={(event) => {
            event.currentTarget.onerror = null;
            event.currentTarget.src = '/logobfang.svg';
          }}
        />
      )}
      <div className="min-w-0 flex flex-col">
        <div className="flex items-center gap-1.5 flex-wrap">
          {profileUrl ? (
            <a href={profileUrl} className="min-w-0">
              {NameNode}
            </a>
          ) : (
            NameNode
          )}
          {displayBadges.map((badge) => (
            <span
              key={`${badge.code}-${badge.label}`}
              className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold"
              style={{
                color: badge.color || '#f8f8f2',
                backgroundColor: badge.color ? `${badge.color}22` : 'hsl(var(--secondary))'
              }}
            >
              {badge.label}
            </span>
          ))}
          {shouldShowRoleBadge ? <RoleBadge role={user.role} /> : null}
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          {showUsername && user.displayName && (
            <>
              <span className="truncate max-w-[120px]">@{user.username}</span>
              <span>·</span>
            </>
          )}
          {timestamp && <span>{timestamp}</span>}
        </div>
      </div>
    </div>
  );
});
