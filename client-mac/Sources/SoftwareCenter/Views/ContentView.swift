import SwiftUI

struct ContentView: View {
    @State private var items: [CatalogItem] = []
    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var statusByItem: [Int: String] = [:]

    var body: some View {
        NavigationStack {
            Group {
                if isLoading {
                    ProgressView("Loading catalog…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let errorMessage {
                    VStack(spacing: 8) {
                        Text("Couldn't reach the Software Center").font(.headline)
                        Text(errorMessage).font(.caption).foregroundStyle(.secondary)
                        Button("Retry") { Task { await load() } }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if items.isEmpty {
                    Text("No approved apps yet — check back soon.")
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    List(items) { item in
                        HStack {
                            Text(item.icon).font(.largeTitle)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(item.name).font(.headline)
                                Text("\(item.category) · v\(item.version)")
                                    .font(.caption).foregroundStyle(.secondary)
                                Text(item.description)
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            if let status = statusByItem[item.id] {
                                Text(status).font(.caption).foregroundStyle(.green)
                            } else {
                                Button("Install") {
                                    Task { await install(item) }
                                }
                            }
                        }
                        .padding(.vertical, 4)
                    }
                }
            }
            .navigationTitle("🛒 Software Center")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button("Refresh") { Task { await load() } }
                }
            }
        }
        .frame(minWidth: 480, minHeight: 420)
        .task { await load() }
    }

    private func load() async {
        isLoading = true
        errorMessage = nil
        await CatalogService.checkIn()
        do {
            items = try await CatalogService.fetchCatalog()
        } catch {
            errorMessage = "Is the catalog server running at \(CatalogService.baseURL.absoluteString)?"
        }
        isLoading = false
    }

    private func install(_ item: CatalogItem) async {
        statusByItem[item.id] = "Downloading…"
        let outcome = await InstallService.install(item)
        switch outcome {
        case .downloaded:
            statusByItem[item.id] = "Downloaded ✓"
        case .failed:
            statusByItem[item.id] = nil
        }
    }
}
