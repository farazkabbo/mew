import { DesktopBridge } from "@/features/desktop/DesktopBridge";
import { TourGuide } from "@/features/tour/TourGuide";

/** The app's pages (notebook, courses, review, settings). */
export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <>
      {children}
      <DesktopBridge />
      <TourGuide />
    </>
  );
}
