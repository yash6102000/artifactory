import AppKit
import Foundation

/// Handles getting a catalog item's installer onto disk and running it.
///
/// WHAT THIS DOES NOT DO YET, ON PURPOSE:
/// Actually installing a .pkg needs admin rights, which means a signed
/// privileged helper (SMAppService/SMJobBless + XPC, per the plan's Tech
/// Stack tab) — that requires a real Apple Developer ID signing identity
/// to build and test properly, which this scaffold doesn't have. Wiring
/// that up is real Phase 1 work, not something to fake here.
///
/// For now this downloads the real file from the catalog server and opens
/// it with Finder/Installer.app, which macOS will prompt for admin
/// credentials on — a manual stand-in for the automated privileged path.
enum InstallService {
    enum InstallOutcome {
        case downloaded(URL)
        case failed(Error)
    }

    static func install(_ item: CatalogItem) async -> InstallOutcome {
        do {
            let (tempURL, response) = try await URLSession.shared.download(
                from: CatalogService.downloadURL(for: item)
            )
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                await CatalogService.reportInstallEvent(packageId: item.id, status: "failed")
                return .failed(CatalogServiceError.badResponse)
            }

            let destination = FileManager.default.temporaryDirectory
                .appendingPathComponent("\(item.name)-\(item.version)")
                .appendingPathExtension(tempURL.pathExtension.isEmpty ? "pkg" : tempURL.pathExtension)
            try? FileManager.default.removeItem(at: destination)
            try FileManager.default.moveItem(at: tempURL, to: destination)

            NSWorkspace.shared.open(destination)
            await CatalogService.reportInstallEvent(packageId: item.id, status: "downloaded")
            return .downloaded(destination)
        } catch {
            await CatalogService.reportInstallEvent(packageId: item.id, status: "failed")
            return .failed(error)
        }
    }
}
