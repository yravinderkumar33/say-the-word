import Foundation

/// One JSON object per line, in both directions.
public enum JSONLines {
    /// Encodes an object as a single line of JSON, without a trailing newline.
    /// Keys are sorted so output is stable. Returns nil if the object is not valid JSON.
    public static func encode(_ object: [String: Any]) -> String? {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(
                  withJSONObject: object,
                  options: [.sortedKeys, .withoutEscapingSlashes]
              )
        else { return nil }
        return String(decoding: data, as: UTF8.self)
    }

    /// Decodes one line. Returns nil for anything that is not a JSON object.
    public static func decode(_ line: String) -> [String: Any]? {
        guard let value = try? JSONSerialization.jsonObject(with: Data(line.utf8)) else { return nil }
        return value as? [String: Any]
    }

    /// Reads an integer field, refusing booleans (which JSON bridging would otherwise accept as 0 or 1).
    public static func integer(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID()
        else { return nil }
        return value as? Int
    }
}
