import { DesktopBridge } from "@/features/desktop/DesktopBridge";

/** The app's pages (notebook, courses, review, settings). */
export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <>
      {children}
      <DesktopBridge />
    </>
  );
}
