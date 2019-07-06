import { ParserState, Context, Flags } from '../common';
import { Token } from '../token';
import { nextCP, toHex, CharTypes, CharFlags, isIdentifierStart, NumberKind } from './';
import { Chars } from '../chars';
import { report, Errors } from '../errors';

/**
 * Scans numeric literal
 *
 * @param parser  Parser object
 * @param context Context masks
 * @param isFloat
 */
export function scanNumber(parser: ParserState, context: Context, kind: NumberKind): Token {
  // DecimalLiteral ::
  //   DecimalIntegerLiteral . DecimalDigits_opt
  //   . DecimalDigits
  let char = parser.nextCP;
  let value: any = 0;
  let digit = 9;
  let atStart = kind & NumberKind.Float ? 1 : 0;
  let digits = 0;
  let allowSeparator: 0 | 1 = 0;

  if (kind & NumberKind.Float) {
    value = '.' + scanDecimalDigitsOrSeparator(parser, char);
    char = parser.nextCP;
    // It is a Syntax Error if the MV is not an integer. (dot decimalDigits)
    if (char === Chars.LowerN) report(parser, Errors.InvalidBigInt);
  } else {
    if (char === Chars.Zero) {
      char = nextCP(parser);

      // Hex
      if ((char | 32) === Chars.LowerX) {
        kind = NumberKind.Hex;
        char = nextCP(parser); // skips 'X', 'x'
        while (CharTypes[char] & (CharFlags.Hex | CharFlags.Underscore)) {
          if (char === Chars.Underscore) {
            if (!allowSeparator) report(parser, Errors.ContinuousNumericSeparator);
            allowSeparator = 0;
            char = nextCP(parser);
            continue;
          }
          allowSeparator = 1;
          value = value * 0x10 + toHex(char);
          digits++;
          char = nextCP(parser);
        }

        if (digits < 1 || !allowSeparator) {
          report(parser, digits < 1 ? Errors.MissingHexDigits : Errors.TrailingNumericSeparator);
        }
        // Octal
      } else if ((char | 32) === Chars.LowerO) {
        kind = NumberKind.Octal;
        char = nextCP(parser); // skips 'X', 'x'
        while (CharTypes[char] & (CharFlags.Octal | CharFlags.Underscore)) {
          if (char === Chars.Underscore) {
            if (!allowSeparator) {
              report(parser, Errors.ContinuousNumericSeparator);
            }
            allowSeparator = 0;
            char = nextCP(parser);
            continue;
          }
          allowSeparator = 1;
          value = value * 8 + (char - Chars.Zero);
          digits++;
          char = nextCP(parser);
        }
        if (digits < 1 || !allowSeparator) {
          report(parser, digits < 1 ? Errors.MissingHexDigits : Errors.TrailingNumericSeparator);
        }
      } else if ((char | 32) === Chars.LowerB) {
        kind = NumberKind.Binary;
        char = nextCP(parser); // skips 'B', 'b'
        while (CharTypes[char] & (CharFlags.Binary | CharFlags.Underscore)) {
          if (char === Chars.Underscore) {
            if (!allowSeparator) {
              report(parser, Errors.ContinuousNumericSeparator);
            }
            allowSeparator = 0;
            char = nextCP(parser);
            continue;
          }
          allowSeparator = 1;
          value = value * 2 + (char - Chars.Zero);
          digits++;
          char = nextCP(parser);
        }
        if (digits < 1 || !allowSeparator) {
          report(parser, digits < 1 ? Errors.MissingHexDigits : Errors.TrailingNumericSeparator);
        }
      } else if (CharTypes[char] & CharFlags.Octal) {
        // Octal integer literals are not permitted in strict mode code
        if (context & Context.Strict) report(parser, Errors.StrictOctalEscape);
        kind = NumberKind.ImplicitOctal;
        while (CharTypes[char] & CharFlags.Decimal) {
          if (CharTypes[char] & CharFlags.ImplicitOctalDigits) {
            kind = NumberKind.DecimalWithLeadingZero;
            atStart = 0;
            break;
          }
          value = value * 8 + (char - Chars.Zero);
          char = nextCP(parser);
        }
      } else if (CharTypes[char] & CharFlags.ImplicitOctalDigits) {
        if (context & Context.Strict) report(parser, Errors.StrictOctalEscape);
        else parser.flags = Flags.Octals;
        kind = NumberKind.DecimalWithLeadingZero;
      } else if (char === Chars.Underscore) {
        report(parser, Errors.Unexpected);
      }
    }

    // Parse decimal digits and allow trailing fractional part
    if (kind & NumberKind.DecimalNumberKind) {
      if (atStart) {
        while (digit >= 0 && CharTypes[char] & (CharFlags.Decimal | CharFlags.Underscore)) {
          if (char === Chars.Underscore) {
            char = nextCP(parser);
            if (char === Chars.Underscore) report(parser, Errors.ContinuousNumericSeparator);
            allowSeparator = 1;
            continue;
          }
          allowSeparator = 0;
          value = 10 * value + (char - Chars.Zero);
          char = nextCP(parser);
          --digit;
        }

        if (allowSeparator) report(parser, Errors.TrailingNumericSeparator);

        if (digit >= 0 && !isIdentifierStart(char) && char !== Chars.Period) {
          // Most numbers are pure decimal integers without fractional component
          // or exponential notation.  Handle that with optimized code.
          parser.tokenValue = value;
          if (context & Context.OptionsRaw) parser.tokenRaw = parser.source.slice(parser.tokenIndex, parser.index);
          return Token.NumericLiteral;
        }
      }

      value += scanDecimalDigitsOrSeparator(parser, char);

      char = parser.nextCP;

      // Consume any decimal dot and fractional component.
      if (char === Chars.Period) {
        if (nextCP(parser) === Chars.Underscore) report(parser, Errors.Unexpected);
        kind = NumberKind.Float;
        value += '.' + scanDecimalDigitsOrSeparator(parser, parser.nextCP);
        char = parser.nextCP;
      }
    }
  }
  const end = parser.index;

  let isBigInt: 0 | 1 = 0;

  if (char === Chars.LowerN && kind & NumberKind.ValidBigIntKind) {
    isBigInt = 1;
    char = nextCP(parser);
  } else {
    // Consume any exponential notation.
    if ((char | 32) === Chars.LowerE) {
      char = nextCP(parser);

      // '-', '+'
      if (CharTypes[char] & CharFlags.Exponent) char = nextCP(parser);

      const { index } = parser;

      // Exponential notation must contain at least one digit
      if ((CharTypes[char] & CharFlags.Decimal) < 1) report(parser, Errors.MissingExponent);

      // Consume exponential digits
      value += parser.source.substring(end, index) + scanDecimalDigitsOrSeparator(parser, char);

      char = parser.nextCP;
    }
  }

  // The source character immediately following a numeric literal must
  // not be an identifier start or a decimal digit
  if ((parser.index < parser.end && CharTypes[char] & CharFlags.Decimal) || isIdentifierStart(char)) {
    report(parser, Errors.IDStartAfterNumber);
  }

  if (isBigInt) {
    parser.tokenRaw = parser.source.slice(parser.tokenIndex, parser.index);
    parser.tokenValue = parseInt(value, 0xa);
    return Token.BigIntLiteral;
  }

  parser.tokenValue =
    kind & (NumberKind.ImplicitOctal | NumberKind.Binary | NumberKind.Hex | NumberKind.Octal)
      ? value
      : kind & NumberKind.DecimalWithLeadingZero
      ? parseFloat(parser.source.substring(parser.tokenIndex, parser.index))
      : +value;

  if (context & Context.OptionsRaw) parser.tokenRaw = parser.source.slice(parser.tokenIndex, parser.index);

  return Token.NumericLiteral;
}

/**
 * Scans numeric literal and skip underscore '_' if it exist
 *
 * @param parser  Parser object
 * @param char Code point
 */
export function scanDecimalDigitsOrSeparator(parser: ParserState, char: number): string {
  let allowSeparator: 0 | 1 = 0;
  let start = parser.index;
  let ret = '';
  while (CharTypes[char] & (CharFlags.Decimal | CharFlags.Underscore)) {
    if (char === Chars.Underscore) {
      const { index } = parser;
      char = nextCP(parser);
      if (char === Chars.Underscore) report(parser, Errors.ContinuousNumericSeparator);
      allowSeparator = 1;
      ret += parser.source.substring(start, index);
      start = parser.index;
      continue;
    }
    allowSeparator = 0;
    char = nextCP(parser);
  }

  if (allowSeparator) report(parser, Errors.TrailingNumericSeparator);

  return ret + parser.source.substring(start, parser.index);
}