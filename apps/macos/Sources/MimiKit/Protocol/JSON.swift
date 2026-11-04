import Foundation

/// Any JSON value. Frames are read through this rather than strict `Codable` types: a newer core adds
/// fields and frames, and an older one leaves some out (Q11: work with every server version), so every
/// read is lenient — a missing or odd field is its default, never a thrown error.
public enum JSON: Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSON])
    case object([String: JSON])

    public init(parsing text: String) throws {
        self = try JSON(data: Data(text.utf8))
    }

    public init(data: Data) throws {
        self = JSON(any: try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]))
    }

    public init(any value: Any?) {
        switch value {
        case nil, is NSNull: self = .null
        case let number as NSNumber:
            // JSONSerialization gives booleans as NSNumber too; tell them apart by their type.
            self = CFGetTypeID(number) == CFBooleanGetTypeID() ? .bool(number.boolValue) : .number(number.doubleValue)
        case let text as String: self = .string(text)
        case let list as [Any]: self = .array(list.map { JSON(any: $0) })
        case let map as [String: Any]: self = .object(map.mapValues { JSON(any: $0) })
        default: self = .null
        }
    }

    public subscript(key: String) -> JSON {
        if case .object(let map) = self { return map[key] ?? .null }
        return .null
    }

    public var string: String? {
        if case .string(let text) = self { return text }
        return nil
    }

    public var str: String { string ?? "" }

    /// A whole number (ids, counts); a number with a fraction or out of range is nil.
    public var int: Int64? {
        if case .number(let value) = self, value.rounded() == value, abs(value) < 9.0e15 { return Int64(value) }
        return nil
    }

    public var double: Double? {
        if case .number(let value) = self { return value }
        return nil
    }

    /// Only a JSON true is true (like the C# app's Bool helper).
    public var bool: Bool {
        if case .bool(let value) = self { return value }
        return false
    }

    public var array: [JSON] {
        if case .array(let list) = self { return list }
        return []
    }

    public var object: [String: JSON]? {
        if case .object(let map) = self { return map }
        return nil
    }

    public var isNull: Bool { self == .null }

    public var any: Any {
        switch self {
        case .null: return NSNull()
        case .bool(let value): return value
        case .number(let value): return value.rounded() == value && abs(value) < 9.0e15 ? Int64(value) as Any : value
        case .string(let value): return value
        case .array(let list): return list.map(\.any)
        case .object(let map): return map.mapValues(\.any)
        }
    }

    /// Compact text, keys sorted (stable for tests); Thai stays as it is.
    public var text: String {
        guard let data = try? JSONSerialization.data(withJSONObject: any, options: [.fragmentsAllowed, .sortedKeys, .withoutEscapingSlashes]) else { return "null" }
        return String(decoding: data, as: UTF8.self)
    }
}

extension JSON: ExpressibleByStringLiteral, ExpressibleByIntegerLiteral, ExpressibleByBooleanLiteral, ExpressibleByDictionaryLiteral, ExpressibleByArrayLiteral, ExpressibleByNilLiteral {
    public init(stringLiteral value: String) { self = .string(value) }
    public init(integerLiteral value: Int) { self = .number(Double(value)) }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
    public init(dictionaryLiteral elements: (String, JSON)...) { self = .object(Dictionary(elements, uniquingKeysWith: { _, last in last })) }
    public init(arrayLiteral elements: JSON...) { self = .array(elements) }
    public init(nilLiteral: ()) { self = .null }
}

public extension JSON {
    static func int(_ value: Int64) -> JSON { .number(Double(value)) }
    static func optional(_ value: String?) -> JSON { value.map(JSON.string) ?? .null }
    static func optional(_ value: Int64?) -> JSON { value.map { .number(Double($0)) } ?? .null }
}
