#include "../core.h"
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
#include <stdexcept>
#include <vector>

struct Fake {
    std::vector<e4eg::Batch> submitted;
    bool fail = false, unavailable = false;
    int selected = -1;
    bool submit(const e4eg::Batch & b) { submitted.push_back(b); return !fail; }
    std::vector<float> read_logits(int index, size_t n) {
        selected = index;
        if (unavailable) return {};
        assert(submitted.back().at(index).output);
        return std::vector<float>(n, float(submitted.back().at(index).position));
    }
};
int main() {
    const std::vector<int32_t> tokens{7, 8, 9, 10};
    auto a = e4eg::schedule('A', tokens), b = e4eg::schedule('B', tokens);
    assert(a.size() == 1 && a[0].size() == 4 && b.size() == 2 && b[0].size() == 3 && b[1].size() == 1);
    for (size_t i = 0; i < tokens.size(); ++i) {
        const auto & x = a[0][i]; const auto & y = i == 3 ? b[1][0] : b[0][i];
        assert(x.token == y.token && x.position == y.position && x.sequence == 0 && y.sequence == 0);
        assert(x.output == (i == 3) && y.output == (i == 3));
    }
    Fake fa, fb;
    assert(e4eg::evaluate(fa, a, 3) == std::vector<float>(3, 3));
    assert(e4eg::evaluate(fb, b, 3) == std::vector<float>(3, 3));
    assert(fa.selected == 3 && fb.selected == 0);
    for (bool missing : {false, true}) {
        Fake f; f.fail = !missing; f.unavailable = missing;
        bool rejected = false; try { (void)e4eg::evaluate(f, a, 3); } catch (const std::runtime_error &) { rejected = true; }
        assert(rejected);
    }
    bool rejected = false; try { (void)e4eg::schedule('C', tokens); } catch (const std::runtime_error &) { rejected = true; }
    assert(rejected);
}
