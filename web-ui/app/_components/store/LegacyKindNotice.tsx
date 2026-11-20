import { History } from "lucide-react";
import { useTranslations } from "next-intl";

import { cn } from "../../_lib/cn";
import { isLegacyKind, type PluginKind } from "../../_lib/storeTypes";

interface LegacyKindNoticeProps {
  kind: PluginKind;
  className?: string;
}

/**
 * Spec 2042 §5.10, the contract step — an installed plugin of a retired kind
 * (`agent`, `extension`) keeps running, but the kernel accepts no new version
 * of it under that kind. Says so on the plugin's page, with what to do: an
 * `agent` is rebuilt as a capability plus an agent, an `extension` comes back
 * as a `system-module` or `model`. Renders nothing for every other kind.
 */
export function LegacyKindNotice({
  kind,
  className,
}: LegacyKindNoticeProps): React.ReactElement | null {
  const t = useTranslations("store.legacyKind");
  if (!isLegacyKind(kind)) return null;
  const which = kind === "agent" ? "agent" : "extension";
  return (
    <div
      role="note"
      className={cn(
        "space-y-2 rounded-lg border border-[color:var(--warning)]/50 bg-[color:var(--warning)]/8 p-4",
        className,
      )}
    >
      <p className="flex items-center gap-2 text-[12px] font-medium uppercase tracking-[0.12em] text-[color:var(--warning)]">
        <History className="size-3.5" aria-hidden />
        {t("title")}
      </p>
      <p className="text-[13px] leading-relaxed text-[color:var(--ink)]">
        {t(`${which}.what`)}
      </p>
      <p className="text-[13px] leading-relaxed text-[color:var(--muted-ink)]">
        {t(`${which}.next`)}
      </p>
    </div>
  );
}
