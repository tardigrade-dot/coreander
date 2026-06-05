package webserver

import "testing"

func TestCleanTTSSpeechInput(t *testing.T) {
	cases := []struct {
		name  string
		input string
		want  string
	}{
		{
			name:  "removes numeric footnote references",
			input: "不过这一指控纠缠了他一生，在他死后还冒出来过。[83]",
			want:  "不过这一指控纠缠了他一生，在他死后还冒出来过。",
		},
		{
			name:  "removes full-width references and collapses whitespace",
			input: "第一句。 ［12］\n第二句。",
			want:  "第一句。 第二句。",
		},
		{
			name:  "removes reference ranges and lists",
			input: "文本[83-84]继续[85，86]结束[87、88]",
			want:  "文本继续结束",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := cleanTTSSpeechInput(tc.input)
			if got != tc.want {
				t.Fatalf("cleanTTSSpeechInput() = %q, want %q", got, tc.want)
			}
		})
	}
}
