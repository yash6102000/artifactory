import Foundation

enum CatalogServiceError: Error {
    case badResponse
}

final class CatalogService {
    // Points at the local dev server from the catalog-server/ folder.
    // In Phase 1 this becomes https://software.internal.company.com
    static let baseURL = URL(string: "http://localhost:3000")!

    static func fetchCatalog() async throws -> [CatalogItem] {
        let url = baseURL.appendingPathComponent("api/catalog")
        let (data, response) = try await URLSession.shared.data(from: url)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw CatalogServiceError.badResponse
        }
        let decoded = try JSONDecoder().decode(CatalogResponse.self, from: data)
        return decoded.packages
    }

    static func checkIn() async {
        let url = baseURL.appendingPathComponent("api/devices/checkin")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: String] = [
            "device_uuid": DeviceIdentity.uuid,
            "hostname": Host.current().localizedName ?? "unknown-mac",
        ]
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        _ = try? await URLSession.shared.data(for: request)
    }

    static func reportInstallEvent(packageId: Int, status: String) async {
        let url = baseURL.appendingPathComponent("api/install-events")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: Any] = [
            "device_uuid": DeviceIdentity.uuid,
            "package_id": packageId,
            "status": status,
        ]
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        _ = try? await URLSession.shared.data(for: request)
    }

    static func downloadURL(for item: CatalogItem) -> URL {
        baseURL.appendingPathComponent("api/packages/\(item.id)/download")
    }
}

/// A stable per-machine identifier, persisted locally, used for check-ins
/// and the audit log. Real deployments would likely use the hardware UUID
/// (`IOPlatformUUID`) instead — this is a placeholder that's good enough
/// for a pilot of a handful of machines.
enum DeviceIdentity {
    private static let key = "software-center-device-uuid"

    static var uuid: String {
        if let existing = UserDefaults.standard.string(forKey: key) {
            return existing
        }
        let fresh = UUID().uuidString
        UserDefaults.standard.set(fresh, forKey: key)
        return fresh
    }
}
