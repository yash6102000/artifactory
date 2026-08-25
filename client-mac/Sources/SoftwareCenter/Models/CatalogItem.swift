import Foundation

struct CatalogItem: Codable, Identifiable {
    let id: Int
    let name: String
    let version: String
    let description: String
    let category: String
    let icon: String
    let sha256: String
}

struct CatalogResponse: Codable {
    let packages: [CatalogItem]
}
