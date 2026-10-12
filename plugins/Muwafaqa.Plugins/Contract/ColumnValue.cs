using System;

namespace Muwafaqa.Plugins.Contract
{
    /// <summary>
    /// A column value reduced to what the guard compares: nothing, a decimal, an integer (option value),
    /// a reference (logical name + id) or a string. No Dataverse types, so it can be unit tested.
    /// Two values of different kinds are never equal. Strings are compared ordinally (null and "" are different).
    /// </summary>
    public sealed class ColumnValue : IEquatable<ColumnValue>
    {
        private enum Kind { Null, Decimal, Int, Reference, Text }

        private readonly Kind _kind;
        private readonly decimal _decimal;
        private readonly int _int;
        private readonly string _text;     // text value, or the logical name of a reference
        private readonly Guid _id;

        private ColumnValue(Kind kind, decimal d = 0m, int i = 0, string text = null, Guid id = default(Guid))
        {
            _kind = kind; _decimal = d; _int = i; _text = text; _id = id;
        }

        public static readonly ColumnValue Null = new ColumnValue(Kind.Null);

        public static ColumnValue FromDecimal(decimal value) { return new ColumnValue(Kind.Decimal, d: value); }
        public static ColumnValue FromInt(int value) { return new ColumnValue(Kind.Int, i: value); }
        public static ColumnValue FromText(string value) { return value == null ? Null : new ColumnValue(Kind.Text, text: value); }
        public static ColumnValue FromReference(string logicalName, Guid id)
        {
            return new ColumnValue(Kind.Reference, text: (logicalName ?? string.Empty).ToLowerInvariant(), id: id);
        }

        public bool IsNull { get { return _kind == Kind.Null; } }

        public bool Equals(ColumnValue other)
        {
            if (ReferenceEquals(other, null) || _kind != other._kind) return false;
            switch (_kind)
            {
                case Kind.Null: return true;
                case Kind.Decimal: return _decimal == other._decimal;
                case Kind.Int: return _int == other._int;
                case Kind.Text: return string.Equals(_text, other._text, StringComparison.Ordinal);
                case Kind.Reference: return _id == other._id && string.Equals(_text, other._text, StringComparison.Ordinal);
                default: return false;
            }
        }

        public override bool Equals(object obj) { return Equals(obj as ColumnValue); }
        public override int GetHashCode() { return (int)_kind * 397 ^ _int ^ _decimal.GetHashCode() ^ (_text ?? string.Empty).GetHashCode() ^ _id.GetHashCode(); }
    }
}
