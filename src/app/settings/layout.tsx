import { Suspense } from "react"
import { SettingsShell } from "@/components/settings/settings-shell"
import { RemoteConnectionGate } from "@/contexts/remote-connection-context"
import { UpdateProvider } from "@/components/providers/update-provider"
import { RouteErrorBoundary } from "@/components/error-boundary/app-error-boundary"

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <Suspense>
      <RemoteConnectionGate>
        <UpdateProvider>
          <SettingsShell>
            {/* A failing settings page keeps the settings navigation: the
                user can still go elsewhere, and leaving clears the error. */}
            <RouteErrorBoundary scope="settings-page" variant="region">
              {children}
            </RouteErrorBoundary>
          </SettingsShell>
        </UpdateProvider>
      </RemoteConnectionGate>
    </Suspense>
  )
}
