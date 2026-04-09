use katextest::MathRenderer;
use std::fs;

fn main() {
    let renderer = MathRenderer::new().expect("Failed to initialize MathRenderer");

    let latex = r"E = mc^2";
    println!("Input LaTeX: {latex}");

    let svg = renderer.tex_to_svg(latex, true).expect("Failed to convert to SVG");
    fs::write("output.svg", &svg).expect("Failed to write SVG");
    println!("SVG saved to output.svg ({} bytes)", svg.len());

    let png = renderer.tex_to_png(latex, true, 3.0).expect("Failed to render PNG");
    fs::write("output.png", &png).expect("Failed to write PNG");
    println!("PNG saved to output.png ({} bytes)", png.len());

    let frac = r"\frac{1}{2}";
    let svg2 = renderer.tex_to_svg(frac, true).unwrap();
    fs::write("output_frac.svg", &svg2).unwrap();
    println!("Fraction SVG saved ({} bytes)", svg2.len());

    let integral = r"\int_0^\infty e^{-x^2} dx = \frac{\sqrt{\pi}}{2}";
    let svg3 = renderer.tex_to_svg(integral, true).unwrap();
    fs::write("output_integral.svg", &svg3).unwrap();
    println!("Integral SVG saved ({} bytes)", svg3.len());
}
