host.onRead((view) => host.render(view.props.length === 0 ? "<p>The stage is empty.</p>" : `<ul aria-label="Props">${view.props.map((prop) => `<li>${prop}</li>`).join("")}</ul>`));
