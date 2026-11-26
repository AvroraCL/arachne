The sRGB, Display P3, Adobe RGB, ProPhoto, Rec.709, Rec.2020, DCI-P3 and scRGB profiles come from [Compact ICC Profiles](https://github.com/saucecontrol/Compact-ICC-Profiles/tree/bdd84663061bc4ae95ca70decff54f581e27f702), released under CC0. AdobeCompat-v2 is compatible with Adobe RGB (1998).

The drawing workspace uses the Rec.709 and Rec.2020 camera curves, a separate Rec.2020 gamma 2.4 profile, and cinema DCI-P3 with gamma 2.6. scRGB-v2 supplies the linear sRGB colorants and transfer curve for bounded 8-bit PNG. The linear data option for masks and material channels uses raw samples.

Arachne generates ACEScg-linear.icc and ACES2065-1-linear.icc with LittleCMS 2 from the published [AP1](https://docs.acescentral.com/encodings/acescg/) and [AP0](https://docs.acescentral.com/encodings/aces2065-1/) chromaticities and ACES white point. These two profiles and their [generator](../../../tools/generate_aces_profiles.py) use the repository's GPL-3.0-only license. The document canvas previews the bounded PNG values through an ICC transform to sRGB.

Gray-g22.icc and Gray-linear.icc describe a single D50 grayscale channel with a gamma of 2.2 or 1.0. Arachne generates these profiles with the same LittleCMS script and distributes them under GPL-3.0-only.

Lab-D50.icc is the D50 CIELAB profile generated with LittleCMS. The same GPL-3.0-only generator supplies its description, copyright and reproducible profile ID.
