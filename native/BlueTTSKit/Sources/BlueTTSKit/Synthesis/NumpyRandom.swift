import Foundation

/// `numpy.random.RandomState` (MT19937 + legacy polar Gaussian), so that with
/// the same seed Swift draws the exact flow-matching noise Python draws with
/// `np.random.seed(seed); np.random.randn(...)`. That makes Swift and Python
/// audio comparable sample by sample (up to ONNX Runtime float differences).
struct NumpyRandom: Sendable {
    private var mt = [UInt32](repeating: 0, count: 624)
    private var index = 624
    private var hasGauss = false
    private var gauss = 0.0

    init(seed: UInt32) {
        mt[0] = seed
        for i in 1..<624 {
            mt[i] = 1_812_433_253 &* (mt[i - 1] ^ (mt[i - 1] >> 30)) &+ UInt32(i)
        }
        index = 624
    }

    /// A random seed from the system generator.
    init() {
        var g = SystemRandomNumberGenerator()
        self.init(seed: UInt32.random(in: 0...UInt32.max, using: &g))
    }

    private mutating func twist() {
        for i in 0..<624 {
            let y = (mt[i] & 0x8000_0000) | (mt[(i + 1) % 624] & 0x7FFF_FFFF)
            var v = mt[(i + 397) % 624] ^ (y >> 1)
            if y & 1 != 0 { v ^= 0x9908_B0DF }
            mt[i] = v
        }
        index = 0
    }

    mutating func nextUInt32() -> UInt32 {
        if index >= 624 { twist() }
        var y = mt[index]
        index += 1
        y ^= y >> 11
        y ^= (y << 7) & 0x9D2C_5680
        y ^= (y << 15) & 0xEFC6_0000
        y ^= y >> 18
        return y
    }

    mutating func nextDouble() -> Double {
        let a = nextUInt32() >> 5, b = nextUInt32() >> 6
        return (Double(a) * 67_108_864.0 + Double(b)) / 9_007_199_254_740_992.0
    }

    /// `legacy_gauss`.
    mutating func nextGaussian() -> Double {
        if hasGauss {
            hasGauss = false
            let t = gauss
            gauss = 0
            return t
        }
        var x1 = 0.0, x2 = 0.0, r2 = 0.0
        repeat {
            x1 = 2.0 * nextDouble() - 1.0
            x2 = 2.0 * nextDouble() - 1.0
            r2 = x1 * x1 + x2 * x2
        } while r2 >= 1.0 || r2 == 0.0
        let f = (-2.0 * log(r2) / r2).squareRoot()
        gauss = f * x1
        hasGauss = true
        return f * x2
    }

    /// `np.random.randn(n).astype(np.float32)`.
    mutating func randn(_ n: Int) -> [Float] {
        var out = [Float](repeating: 0, count: n)
        for i in 0..<n { out[i] = Float(nextGaussian()) }
        return out
    }
}
