import { SiteHeader } from "@/components/SiteHeader";
import { DesktopHomeRedirect } from "@/features/desktop/DesktopHomeRedirect";
import { isClerkConfigured } from "@/lib/auth-mode";

export default function SiteLayout({ children }: LayoutProps<"/">) {
  return (
    <>
      {isClerkConfigured && <DesktopHomeRedirect />}
      <SiteHeader />
      {children}
    </>
  );
}
